// scan/git.ts
// Git status scanning function for multi-workspace support.
// Extracts git status parsing logic from routes/git.ts.

import type { GitStatus } from '../types.ts';

/**
 * Scan git status for a single workspace.
 * Executes git commands in the workspace's WORKSPACE_ROOT directory.
 * 
 * @param workspaceRoot Absolute path to workspace root (where git commands execute)
 * @param workspaceId Workspace identifier to populate in GitStatus object
 * @returns GitStatus object with workspaceId populated, or clean status for non-git repos
 */
export async function scanGitStatus(
  workspaceRoot: string,
  workspaceId: string
): Promise<GitStatus> {
  try {
    const proc = Bun.spawn(
      ['git', 'status', '--porcelain', '-b'],
      { cwd: workspaceRoot, stdout: 'pipe', stderr: 'pipe' }
    );
    const exitCode = await proc.exited;
    
    // Non-git workspace: return clean status with empty arrays
    if (exitCode !== 0) {
      return {
        branch: '',
        clean: true,
        modified: [],
        staged: [],
        untracked: [],
        ahead: 0,
        behind: 0,
        workspaceId,
      };
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
    
    return {
      branch,
      clean,
      modified,
      staged,
      untracked,
      ahead,
      behind,
      workspaceId,
    };
  } catch (err) {
    // Error spawning git: return clean status with empty arrays
    return {
      branch: '',
      clean: true,
      modified: [],
      staged: [],
      untracked: [],
      ahead: 0,
      behind: 0,
      workspaceId,
    };
  }
}
