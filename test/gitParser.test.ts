// Feature: monitor-dashboard-redesign, Property 6: git status porcelain parsing — each path in exactly one array
// Validates: Requirements 5.3, 5.8
//
// The git status --porcelain parsing logic lives inline in the GET /git-status route
// handler in monitor.ts (not exported). This test mirrors that exact same logic in a
// locally-defined `parseGitPorcelain` function so it can be exercised in isolation.

import { test, expect, describe } from 'bun:test';
import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// Mirror of the porcelain parsing logic from monitor.ts GET /git-status
// ---------------------------------------------------------------------------

interface ParsedGitStatus {
  staged: string[];
  modified: string[];
  untracked: string[];
  clean: boolean;
}

/**
 * Parses the stdout of `git status --porcelain -b`.
 * Mirrors the logic in monitor.ts GET /git-status exactly:
 *   - Lines starting with "## " → branch/ahead/behind (skipped here)
 *   - Lines with length < 3 → skipped
 *   - indexCol="?" AND worktreeCol="?" → untracked[]
 *   - indexCol !== " " (and not "??") → staged[] (precedence over modified)
 *   - indexCol === " " AND worktreeCol !== " " → modified[]
 *   - clean = staged.length === 0 && modified.length === 0 && untracked.length === 0
 */
function parseGitPorcelain(stdout: string): ParsedGitStatus {
  const lines = stdout.split('\n');
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) continue;
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
  return { staged, modified, untracked, clean };
}

// ---------------------------------------------------------------------------
// fast-check arbitraries
// ---------------------------------------------------------------------------

// Matches the porcelainLineArb from the design document exactly.
const porcelainLineArb = fc.tuple(
  fc.constantFrom(' ', 'M', 'A', 'D', 'R', 'C', 'U', '?'),
  fc.constantFrom(' ', 'M', 'D', 'A', 'U', '?'),
  fc.string({ minLength: 1, maxLength: 60 }).filter(s => !s.includes('\n'))
).map(([index, worktree, path]) => ({ index, worktree, path }));

/**
 * Builds a porcelain stdout string from an array of line descriptors.
 * Prepends a branch header so the parser has a realistic input.
 */
function buildPorcelainOutput(lines: Array<{ index: string; worktree: string; path: string }>): string {
  const header = '## main...origin/main';
  const body = lines.map(({ index, worktree, path }) => `${index}${worktree} ${path}`);
  return [header, ...body].join('\n');
}

// ---------------------------------------------------------------------------
// Property 6: each path appears in exactly one of staged[], modified[], untracked[]
// ---------------------------------------------------------------------------

describe('Property 6 — git status porcelain parsing: each path in exactly one array', () => {

  test('no path appears in more than one array', () => {
    fc.assert(
      fc.property(
        fc.array(porcelainLineArb, { minLength: 0, maxLength: 30 }),
        (lines) => {
          const stdout = buildPorcelainOutput(lines);
          const { staged, modified, untracked } = parseGitPorcelain(stdout);

          const stagedSet = new Set(staged);
          const modifiedSet = new Set(modified);
          const untrackedSet = new Set(untracked);

          // No path should appear in more than one array
          for (const path of staged) {
            expect(modifiedSet.has(path)).toBe(false);
            expect(untrackedSet.has(path)).toBe(false);
          }
          for (const path of modified) {
            expect(stagedSet.has(path)).toBe(false);
            expect(untrackedSet.has(path)).toBe(false);
          }
          for (const path of untracked) {
            expect(stagedSet.has(path)).toBe(false);
            expect(modifiedSet.has(path)).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('every path from a non-branch input line appears in exactly one array', () => {
    fc.assert(
      fc.property(
        fc.array(porcelainLineArb, { minLength: 0, maxLength: 30 }),
        (lines) => {
          const stdout = buildPorcelainOutput(lines);
          const { staged, modified, untracked } = parseGitPorcelain(stdout);

          const allParsed = new Set([...staged, ...modified, ...untracked]);

          // Every line that the parser should classify must appear somewhere.
          // A line is classifiable if it is non-empty (length >= 3 after joining)
          // and at least one column is non-space (i.e. not a "  path" fully-clean line).
          for (const { index, worktree, path } of lines) {
            const isUntracked = index === '?' && worktree === '?';
            const isStaged = !isUntracked && index !== ' ';
            const isModified = !isUntracked && index === ' ' && worktree !== ' ';

            if (isUntracked || isStaged || isModified) {
              // Path must appear in exactly one array
              expect(allParsed.has(path)).toBe(true);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('staged takes precedence over modified for partially-staged files (index non-space, worktree non-space)', () => {
    fc.assert(
      fc.property(
        // Generate lines where BOTH index and worktree are non-space (and not "??")
        fc.array(
          fc.tuple(
            fc.constantFrom('M', 'A', 'D', 'R', 'C', 'U'),
            fc.constantFrom('M', 'D', 'A', 'U'),
            fc.string({ minLength: 1, maxLength: 60 }).filter(s => !s.includes('\n'))
          ).map(([index, worktree, path]) => ({ index, worktree, path })),
          { minLength: 1, maxLength: 20 }
        ),
        (lines) => {
          const stdout = buildPorcelainOutput(lines);
          const { staged, modified } = parseGitPorcelain(stdout);

          const modifiedSet = new Set(modified);

          // Every path from these partially-staged lines must go to staged, not modified
          for (const { path } of lines) {
            expect(staged).toContain(path);
            expect(modifiedSet.has(path)).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('clean flag is true iff all three arrays are empty', () => {
    fc.assert(
      fc.property(
        fc.array(porcelainLineArb, { minLength: 0, maxLength: 30 }),
        (lines) => {
          const stdout = buildPorcelainOutput(lines);
          const { staged, modified, untracked, clean } = parseGitPorcelain(stdout);

          const expectedClean = staged.length === 0 && modified.length === 0 && untracked.length === 0;
          expect(clean).toBe(expectedClean);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('empty input produces empty arrays and clean=true', () => {
    const { staged, modified, untracked, clean } = parseGitPorcelain('');
    expect(staged).toStrictEqual([]);
    expect(modified).toStrictEqual([]);
    expect(untracked).toStrictEqual([]);
    expect(clean).toBe(true);
  });

  test('branch-only input (no file lines) produces empty arrays and clean=true', () => {
    const { staged, modified, untracked, clean } = parseGitPorcelain('## main...origin/main [ahead 2]');
    expect(staged).toStrictEqual([]);
    expect(modified).toStrictEqual([]);
    expect(untracked).toStrictEqual([]);
    expect(clean).toBe(true);
  });

  test('?? line goes to untracked, not staged or modified', () => {
    const stdout = '## main\n?? new-file.ts';
    const { staged, modified, untracked } = parseGitPorcelain(stdout);
    expect(untracked).toContain('new-file.ts');
    expect(staged).not.toContain('new-file.ts');
    expect(modified).not.toContain('new-file.ts');
  });

  test('M_ (staged modify, clean worktree) goes to staged only', () => {
    const stdout = '## main\nM  src/foo.ts';
    const { staged, modified, untracked } = parseGitPorcelain(stdout);
    expect(staged).toContain('src/foo.ts');
    expect(modified).not.toContain('src/foo.ts');
    expect(untracked).not.toContain('src/foo.ts');
  });

  test('_M (clean index, modified worktree) goes to modified only', () => {
    const stdout = '## main\n M src/bar.ts';
    const { staged, modified, untracked } = parseGitPorcelain(stdout);
    expect(modified).toContain('src/bar.ts');
    expect(staged).not.toContain('src/bar.ts');
    expect(untracked).not.toContain('src/bar.ts');
  });

  test('MM (staged and worktree modified) goes to staged only (precedence)', () => {
    const stdout = '## main\nMM src/baz.ts';
    const { staged, modified, untracked } = parseGitPorcelain(stdout);
    expect(staged).toContain('src/baz.ts');
    expect(modified).not.toContain('src/baz.ts');
    expect(untracked).not.toContain('src/baz.ts');
  });

});
