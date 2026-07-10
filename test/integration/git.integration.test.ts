// Feature: multi-workspace-monitoring, Task 13.3 — Integration tests for git operations
//
// Creates real temporary git repositories in various states and verifies the
// git status scanner correctly interprets `git status --porcelain` output and
// executes git commands in each workspace's WORKSPACE_ROOT directory.
//
// Validates: Requirements 7.1, 7.2, 7.6

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { scanGitStatus } from '../../src/scan/git.ts';

// ---------------------------------------------------------------------------
// Test directory — unique per run to avoid collisions
// ---------------------------------------------------------------------------

const TEST_BASE_DIR = join(tmpdir(), `agenthq-git-integration-${Date.now()}`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Configure git identity so commits work in isolated repos.
 */
function gitConfig(repoDir: string): void {
  spawnSync('git', ['config', 'user.email', 'test@agenthq.test'], { cwd: repoDir });
  spawnSync('git', ['config', 'user.name', 'AgentHQ Test'], { cwd: repoDir });
}

/**
 * Initialise a new git repository at the given path.
 * Returns the repo path for convenience.
 */
function initRepo(repoPath: string): string {
  mkdirSync(repoPath, { recursive: true });
  spawnSync('git', ['init'], { cwd: repoPath });
  gitConfig(repoPath);
  return repoPath;
}

/**
 * Make an initial commit so the repo is not in "no commits yet" state.
 */
function makeInitialCommit(repoPath: string, filename = 'README.md'): void {
  writeFileSync(join(repoPath, filename), `# ${filename}\n`);
  spawnSync('git', ['add', filename], { cwd: repoPath });
  spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  mkdirSync(TEST_BASE_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_BASE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Requirement 7.6: Non-git directory returns GitStatus with clean:true and empty arrays
// ---------------------------------------------------------------------------

describe('Requirement 7.6: Non-git directory handling', () => {
  test('plain directory (no .git) returns clean status with empty arrays', async () => {
    const nonGitDir = join(TEST_BASE_DIR, 'non-git-dir');
    mkdirSync(nonGitDir, { recursive: true });

    const status = await scanGitStatus(nonGitDir, 'workspace-non-git');

    expect(status.workspaceId).toBe('workspace-non-git');
    expect(status.clean).toBe(true);
    expect(status.branch).toBe('');
    expect(status.modified).toStrictEqual([]);
    expect(status.staged).toStrictEqual([]);
    expect(status.untracked).toStrictEqual([]);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  test('non-existent directory returns clean status with empty arrays', async () => {
    const missingDir = join(TEST_BASE_DIR, 'does-not-exist');

    const status = await scanGitStatus(missingDir, 'workspace-missing');

    expect(status.workspaceId).toBe('workspace-missing');
    expect(status.clean).toBe(true);
    expect(status.branch).toBe('');
    expect(status.modified).toStrictEqual([]);
    expect(status.staged).toStrictEqual([]);
    expect(status.untracked).toStrictEqual([]);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Requirement 7.1: Git_Status_Scanner scans git status for each workspace
// Covers all required repo states
// ---------------------------------------------------------------------------

describe('Requirement 7.1: Git status scanning — repo states', () => {
  test('clean repository: clean=true, all arrays empty', async () => {
    const repoDir = join(TEST_BASE_DIR, 'clean-repo');
    initRepo(repoDir);
    makeInitialCommit(repoDir);

    const status = await scanGitStatus(repoDir, 'workspace-clean');

    expect(status.clean).toBe(true);
    expect(status.modified).toStrictEqual([]);
    expect(status.staged).toStrictEqual([]);
    expect(status.untracked).toStrictEqual([]);
    expect(status.workspaceId).toBe('workspace-clean');
    // Branch must be non-empty for a committed repo
    expect(status.branch).toMatch(/\S/);
  });

  test('untracked file: clean=false, file appears in untracked[]', async () => {
    const repoDir = join(TEST_BASE_DIR, 'untracked-repo');
    initRepo(repoDir);
    makeInitialCommit(repoDir);

    writeFileSync(join(repoDir, 'new-file.ts'), 'export const x = 1;\n');

    const status = await scanGitStatus(repoDir, 'workspace-untracked');

    expect(status.clean).toBe(false);
    expect(status.untracked).toContain('new-file.ts');
    expect(status.modified).toStrictEqual([]);
    expect(status.staged).toStrictEqual([]);
  });

  test('modified file (unstaged): clean=false, file appears in modified[]', async () => {
    const repoDir = join(TEST_BASE_DIR, 'modified-repo');
    initRepo(repoDir);
    makeInitialCommit(repoDir, 'source.ts');

    // Modify the committed file without staging
    writeFileSync(join(repoDir, 'source.ts'), 'export const changed = true;\n');

    const status = await scanGitStatus(repoDir, 'workspace-modified');

    expect(status.clean).toBe(false);
    expect(status.modified).toContain('source.ts');
    expect(status.staged).toStrictEqual([]);
    expect(status.untracked).toStrictEqual([]);
  });

  test('staged new file: clean=false, file appears in staged[]', async () => {
    const repoDir = join(TEST_BASE_DIR, 'staged-new-repo');
    initRepo(repoDir);
    makeInitialCommit(repoDir);

    writeFileSync(join(repoDir, 'staged.ts'), 'export const staged = true;\n');
    spawnSync('git', ['add', 'staged.ts'], { cwd: repoDir });

    const status = await scanGitStatus(repoDir, 'workspace-staged');

    expect(status.clean).toBe(false);
    expect(status.staged).toContain('staged.ts');
    expect(status.modified).toStrictEqual([]);
    expect(status.untracked).toStrictEqual([]);
  });

  test('staged modification: clean=false, file appears in staged[]', async () => {
    const repoDir = join(TEST_BASE_DIR, 'staged-mod-repo');
    initRepo(repoDir);
    makeInitialCommit(repoDir, 'app.ts');

    // Modify and stage the file
    writeFileSync(join(repoDir, 'app.ts'), 'export const updated = 42;\n');
    spawnSync('git', ['add', 'app.ts'], { cwd: repoDir });

    const status = await scanGitStatus(repoDir, 'workspace-staged-mod');

    expect(status.clean).toBe(false);
    expect(status.staged).toContain('app.ts');
    expect(status.modified).toStrictEqual([]);
    expect(status.untracked).toStrictEqual([]);
  });

  test('mixed state: staged, modified, and untracked files all detected correctly', async () => {
    const repoDir = join(TEST_BASE_DIR, 'mixed-repo');
    initRepo(repoDir);

    // Commit two files
    writeFileSync(join(repoDir, 'tracked.ts'), 'original\n');
    writeFileSync(join(repoDir, 'also-tracked.ts'), 'original\n');
    spawnSync('git', ['add', '.'], { cwd: repoDir });
    spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir });

    // Staged: new file added to index
    writeFileSync(join(repoDir, 'added.ts'), 'new\n');
    spawnSync('git', ['add', 'added.ts'], { cwd: repoDir });

    // Modified (unstaged): change existing tracked file
    writeFileSync(join(repoDir, 'tracked.ts'), 'modified\n');

    // Untracked: new file not added to index
    writeFileSync(join(repoDir, 'untracked.ts'), 'not staged\n');

    const status = await scanGitStatus(repoDir, 'workspace-mixed');

    expect(status.clean).toBe(false);
    expect(status.staged).toContain('added.ts');
    expect(status.modified).toContain('tracked.ts');
    expect(status.untracked).toContain('untracked.ts');

    // Files must not appear in more than one array
    const stagedSet = new Set(status.staged);
    const modifiedSet = new Set(status.modified);
    const untrackedSet = new Set(status.untracked);

    for (const f of status.staged) {
      expect(modifiedSet.has(f)).toBe(false);
      expect(untrackedSet.has(f)).toBe(false);
    }
    for (const f of status.modified) {
      expect(stagedSet.has(f)).toBe(false);
      expect(untrackedSet.has(f)).toBe(false);
    }
    for (const f of status.untracked) {
      expect(stagedSet.has(f)).toBe(false);
      expect(modifiedSet.has(f)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Requirement 7.2: Git commands execute in each workspace's WORKSPACE_ROOT
// ---------------------------------------------------------------------------

describe('Requirement 7.2: Git commands execute in correct WORKSPACE_ROOT', () => {
  test('two workspaces with different branch names return correct branch per workspace', async () => {
    const repoA = join(TEST_BASE_DIR, 'workspace-branch-a');
    const repoB = join(TEST_BASE_DIR, 'workspace-branch-b');

    // Workspace A — initialise on 'feature-alpha'
    initRepo(repoA);
    makeInitialCommit(repoA);
    spawnSync('git', ['checkout', '-b', 'feature-alpha'], { cwd: repoA });

    // Workspace B — initialise on 'feature-beta'
    initRepo(repoB);
    makeInitialCommit(repoB);
    spawnSync('git', ['checkout', '-b', 'feature-beta'], { cwd: repoB });

    const [statusA, statusB] = await Promise.all([
      scanGitStatus(repoA, 'ws-branch-a'),
      scanGitStatus(repoB, 'ws-branch-b'),
    ]);

    expect(statusA.branch).toBe('feature-alpha');
    expect(statusB.branch).toBe('feature-beta');

    // workspaceId must match what was passed
    expect(statusA.workspaceId).toBe('ws-branch-a');
    expect(statusB.workspaceId).toBe('ws-branch-b');
  });

  test('two workspaces with independent file states do not contaminate each other', async () => {
    const repoA = join(TEST_BASE_DIR, 'workspace-isolated-a');
    const repoB = join(TEST_BASE_DIR, 'workspace-isolated-b');

    // Workspace A — has staged and untracked files
    initRepo(repoA);
    makeInitialCommit(repoA);
    writeFileSync(join(repoA, 'staged-a.ts'), 'a\n');
    spawnSync('git', ['add', 'staged-a.ts'], { cwd: repoA });
    writeFileSync(join(repoA, 'untracked-a.ts'), 'a untracked\n');

    // Workspace B — clean
    initRepo(repoB);
    makeInitialCommit(repoB);

    const [statusA, statusB] = await Promise.all([
      scanGitStatus(repoA, 'ws-isolated-a'),
      scanGitStatus(repoB, 'ws-isolated-b'),
    ]);

    // A is dirty
    expect(statusA.clean).toBe(false);
    expect(statusA.staged).toContain('staged-a.ts');
    expect(statusA.untracked).toContain('untracked-a.ts');

    // B is clean and contains none of A's files
    expect(statusB.clean).toBe(true);
    expect(statusB.staged).toStrictEqual([]);
    expect(statusB.modified).toStrictEqual([]);
    expect(statusB.untracked).toStrictEqual([]);

    // No A files should appear in B's status
    expect(statusB.staged).not.toContain('staged-a.ts');
    expect(statusB.untracked).not.toContain('untracked-a.ts');
  });

  test('three workspaces scanned concurrently return correct workspace-specific results', async () => {
    const repos = ['ws-concurrent-1', 'ws-concurrent-2', 'ws-concurrent-3'].map(
      name => ({ name, path: join(TEST_BASE_DIR, name) })
    );

    // ws-concurrent-1: clean
    initRepo(repos[0].path);
    makeInitialCommit(repos[0].path);

    // ws-concurrent-2: one modified file
    initRepo(repos[1].path);
    makeInitialCommit(repos[1].path, 'data.ts');
    writeFileSync(join(repos[1].path, 'data.ts'), 'changed\n');

    // ws-concurrent-3: non-git directory
    mkdirSync(repos[2].path, { recursive: true });

    const statuses = await Promise.all(
      repos.map(r => scanGitStatus(r.path, r.name))
    );

    // ws-concurrent-1: clean git repo
    expect(statuses[0].workspaceId).toBe('ws-concurrent-1');
    expect(statuses[0].clean).toBe(true);
    expect(statuses[0].branch).toMatch(/\S/);

    // ws-concurrent-2: modified file
    expect(statuses[1].workspaceId).toBe('ws-concurrent-2');
    expect(statuses[1].clean).toBe(false);
    expect(statuses[1].modified).toContain('data.ts');

    // ws-concurrent-3: non-git (Req 7.6)
    expect(statuses[2].workspaceId).toBe('ws-concurrent-3');
    expect(statuses[2].clean).toBe(true);
    expect(statuses[2].branch).toBe('');
    expect(statuses[2].staged).toStrictEqual([]);
    expect(statuses[2].modified).toStrictEqual([]);
    expect(statuses[2].untracked).toStrictEqual([]);
  });

  test('workspaceId in returned GitStatus matches the argument passed to scanGitStatus', async () => {
    const repoDir = join(TEST_BASE_DIR, 'workspace-id-check');
    initRepo(repoDir);
    makeInitialCommit(repoDir);

    const workspaceIds = ['alpha', 'beta', 'my-project-1', 'some-other-workspace'];

    // Call scanGitStatus with the same physical repo but different workspaceId values
    const statuses = await Promise.all(
      workspaceIds.map(id => scanGitStatus(repoDir, id))
    );

    for (let i = 0; i < workspaceIds.length; i++) {
      expect(statuses[i].workspaceId).toBe(workspaceIds[i]);
    }
  });
});
