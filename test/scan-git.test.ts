// Feature: multi-workspace-monitoring, Task 4.3 — Tests for git status scanner
// Validates: Requirements 2.5, 7.1, 7.2, 7.6

import { test, expect, describe } from 'bun:test';
import { scanGitStatus } from '../src/scan/git.ts';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

// Use OS temp directory to avoid parent git repo interference
const TEST_DIR = join(tmpdir(), 'agenthq-git-test-' + Date.now());

// ---------------------------------------------------------------------------
// Unit Tests: Basic functionality
// ---------------------------------------------------------------------------

describe('scanGitStatus basic functionality', () => {
  test('returns clean status for non-git directory', async () => {
    const nonGitDir = join(TEST_DIR, 'non-git-workspace-' + Date.now());
    mkdirSync(nonGitDir, { recursive: true });

    try {
      const status = await scanGitStatus(nonGitDir, 'test-workspace');

      expect(status.workspaceId).toBe('test-workspace');
      expect(status.clean).toBe(true);
      expect(status.branch).toBe('');
      expect(status.modified).toStrictEqual([]);
      expect(status.staged).toStrictEqual([]);
      expect(status.untracked).toStrictEqual([]);
      expect(status.ahead).toBe(0);
      expect(status.behind).toBe(0);
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  test('returns clean status for non-existent directory', async () => {
    const nonExistentDir = join(TEST_DIR, 'does-not-exist-' + Date.now());

    const status = await scanGitStatus(nonExistentDir, 'missing-workspace');

    expect(status.workspaceId).toBe('missing-workspace');
    expect(status.clean).toBe(true);
    expect(status.branch).toBe('');
    expect(status.modified).toStrictEqual([]);
    expect(status.staged).toStrictEqual([]);
    expect(status.untracked).toStrictEqual([]);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  test('populates workspaceId field correctly', async () => {
    const gitDir = join(TEST_DIR, 'git-workspace-id-test');
    mkdirSync(gitDir, { recursive: true });

    try {
      // Initialize git repo
      spawnSync('git', ['init'], { cwd: gitDir });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitDir });
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: gitDir });

      const status = await scanGitStatus(gitDir, 'my-workspace-id');

      expect(status.workspaceId).toBe('my-workspace-id');
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Unit Tests: Git status parsing
// ---------------------------------------------------------------------------

describe('scanGitStatus git parsing', () => {
  test('detects clean repository', async () => {
    const gitDir = join(TEST_DIR, 'clean-repo');
    mkdirSync(gitDir, { recursive: true });

    try {
      // Initialize git repo with initial commit
      spawnSync('git', ['init'], { cwd: gitDir });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitDir });
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: gitDir });
      writeFileSync(join(gitDir, 'README.md'), '# Test Repo');
      spawnSync('git', ['add', '.'], { cwd: gitDir });
      spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: gitDir });

      const status = await scanGitStatus(gitDir, 'clean-workspace');

      expect(status.clean).toBe(true);
      expect(status.modified).toStrictEqual([]);
      expect(status.staged).toStrictEqual([]);
      expect(status.untracked).toStrictEqual([]);
      expect(status.workspaceId).toBe('clean-workspace');
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  });

  test('detects untracked files', async () => {
    const gitDir = join(TEST_DIR, 'untracked-files');
    mkdirSync(gitDir, { recursive: true });

    try {
      // Initialize git repo
      spawnSync('git', ['init'], { cwd: gitDir });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitDir });
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: gitDir });
      
      // Create untracked file
      writeFileSync(join(gitDir, 'untracked.txt'), 'new file');

      const status = await scanGitStatus(gitDir, 'untracked-workspace');

      expect(status.clean).toBe(false);
      expect(status.untracked).toContain('untracked.txt');
      expect(status.modified).toStrictEqual([]);
      expect(status.staged).toStrictEqual([]);
      expect(status.workspaceId).toBe('untracked-workspace');
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  });

  test('detects staged files', async () => {
    const gitDir = join(TEST_DIR, 'staged-files');
    mkdirSync(gitDir, { recursive: true });

    try {
      // Initialize git repo with initial commit
      spawnSync('git', ['init'], { cwd: gitDir });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitDir });
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: gitDir });
      writeFileSync(join(gitDir, 'README.md'), '# Test');
      spawnSync('git', ['add', '.'], { cwd: gitDir });
      spawnSync('git', ['commit', '-m', 'Initial'], { cwd: gitDir });

      // Create and stage a new file
      writeFileSync(join(gitDir, 'staged.txt'), 'staged content');
      spawnSync('git', ['add', 'staged.txt'], { cwd: gitDir });

      const status = await scanGitStatus(gitDir, 'staged-workspace');

      expect(status.clean).toBe(false);
      expect(status.staged).toContain('staged.txt');
      expect(status.modified).toStrictEqual([]);
      expect(status.untracked).toStrictEqual([]);
      expect(status.workspaceId).toBe('staged-workspace');
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  });

  test('detects modified files', async () => {
    const gitDir = join(TEST_DIR, 'modified-files');
    mkdirSync(gitDir, { recursive: true });

    try {
      // Initialize git repo with initial commit
      spawnSync('git', ['init'], { cwd: gitDir });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitDir });
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: gitDir });
      writeFileSync(join(gitDir, 'file.txt'), 'original');
      spawnSync('git', ['add', '.'], { cwd: gitDir });
      spawnSync('git', ['commit', '-m', 'Initial'], { cwd: gitDir });

      // Modify the file
      writeFileSync(join(gitDir, 'file.txt'), 'modified content');

      const status = await scanGitStatus(gitDir, 'modified-workspace');

      expect(status.clean).toBe(false);
      expect(status.modified).toContain('file.txt');
      expect(status.staged).toStrictEqual([]);
      expect(status.untracked).toStrictEqual([]);
      expect(status.workspaceId).toBe('modified-workspace');
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  });

  test('detects branch name', async () => {
    const gitDir = join(TEST_DIR, 'branch-name');
    mkdirSync(gitDir, { recursive: true });

    try {
      // Initialize git repo with initial commit
      spawnSync('git', ['init'], { cwd: gitDir });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitDir });
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: gitDir });
      writeFileSync(join(gitDir, 'README.md'), '# Test');
      spawnSync('git', ['add', '.'], { cwd: gitDir });
      spawnSync('git', ['commit', '-m', 'Initial'], { cwd: gitDir });

      const status = await scanGitStatus(gitDir, 'branch-workspace');

      // Default branch could be 'main' or 'master' depending on git config
      expect(status.branch).toMatch(/^(main|master)$/);
      expect(status.workspaceId).toBe('branch-workspace');
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Unit Tests: Multiple file types
// ---------------------------------------------------------------------------

describe('scanGitStatus multiple file types', () => {
  test('correctly categorizes mixed file states', async () => {
    const gitDir = join(TEST_DIR, 'mixed-states');
    mkdirSync(gitDir, { recursive: true });

    try {
      // Initialize git repo with initial commit
      spawnSync('git', ['init'], { cwd: gitDir });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitDir });
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: gitDir });
      writeFileSync(join(gitDir, 'existing.txt'), 'existing');
      spawnSync('git', ['add', '.'], { cwd: gitDir });
      spawnSync('git', ['commit', '-m', 'Initial'], { cwd: gitDir });

      // Create mixed state: staged, modified, and untracked files
      writeFileSync(join(gitDir, 'staged.txt'), 'staged');
      spawnSync('git', ['add', 'staged.txt'], { cwd: gitDir });

      writeFileSync(join(gitDir, 'existing.txt'), 'modified');

      writeFileSync(join(gitDir, 'untracked.txt'), 'untracked');

      const status = await scanGitStatus(gitDir, 'mixed-workspace');

      expect(status.clean).toBe(false);
      expect(status.staged).toContain('staged.txt');
      expect(status.modified).toContain('existing.txt');
      expect(status.untracked).toContain('untracked.txt');
      expect(status.workspaceId).toBe('mixed-workspace');

      // Verify no overlap between arrays
      const stagedSet = new Set(status.staged);
      const modifiedSet = new Set(status.modified);
      const untrackedSet = new Set(status.untracked);

      for (const file of status.staged) {
        expect(modifiedSet.has(file)).toBe(false);
        expect(untrackedSet.has(file)).toBe(false);
      }
      for (const file of status.modified) {
        expect(stagedSet.has(file)).toBe(false);
        expect(untrackedSet.has(file)).toBe(false);
      }
      for (const file of status.untracked) {
        expect(stagedSet.has(file)).toBe(false);
        expect(modifiedSet.has(file)).toBe(false);
      }
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

// Remove test directory after all tests
test('cleanup test fixtures', () => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
  expect(true).toBe(true);
});
