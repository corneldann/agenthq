// Feature: monitor-server-split, Task 3.5 — Property tests for scan/jobs.ts
// Validates: Requirements 13.1, 13.2, 13.4, 13.6

import { test, expect, describe, afterEach } from 'bun:test';
import * as fc from 'fast-check';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { scanJobs } from '../src/scan/jobs.ts';
import type { Job } from '../src/types.ts';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures/output');

// ---------------------------------------------------------------------------
// Helper: build a minimal well-formed .md job file content
// ---------------------------------------------------------------------------

function makeJobMd(agent = 'agenthq', type = 'analysis', done = false): string {
  return [
    `<!-- type: ${type} -->`,
    `<!-- agent: ${agent} -->`,
    `<!-- source: /sessions/2026-01-10_chain-test/session.jsonl -->`,
    '',
    '# Test job',
    '',
    'Some content here.',
    ...(done ? ['', '[agenthq] done in 5.0s'] : []),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Property 5: Scan module purity — no setInterval called on import or scan
// ---------------------------------------------------------------------------

describe('scan/jobs.ts module purity', () => {
  test('calling scanJobs does not start any new interval', async () => {
    let callCount = 0;
    const original = globalThis.setInterval;
    // @ts-expect-error — patching global for spy
    globalThis.setInterval = (...args: unknown[]) => {
      callCount++;
      return original(...(args as Parameters<typeof original>));
    };
    await scanJobs(FIXTURE_DIR);
    globalThis.setInterval = original;
    expect(callCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Invariant: result length ≥ 0; every Job has a non-empty id
// ---------------------------------------------------------------------------

describe('scanJobs invariants', () => {
  test('result length is non-negative and every Job has a non-empty id (fixture)', async () => {
    const jobs = await scanJobs(FIXTURE_DIR);
    expect(jobs.length).toBeGreaterThanOrEqual(0);
    for (const job of jobs) {
      expect(job.id.length).toBeGreaterThan(0);
    }
  });

  test('fixture returns exactly 3 prompt jobs', async () => {
    const jobs = await scanJobs(FIXTURE_DIR);
    // Only count .md-sourced jobs (not synthetic bgJobs/buildJobs from sidecar files)
    const promptJobs = jobs.filter(j => j.mdFile !== '');
    expect(promptJobs.length).toBe(3);
  });

  test('fc: every job in the result has a non-empty id', async () => {
    const jobs = await scanJobs(FIXTURE_DIR);
    fc.assert(
      fc.property(
        fc.constantFrom(...jobs),
        (job: Job) => job.id.length > 0
      ),
      { numRuns: jobs.length * 3 }
    );
  });
});

// ---------------------------------------------------------------------------
// Round-trip (idempotency): two consecutive scanJobs calls return equivalent results
// ---------------------------------------------------------------------------

describe('scanJobs round-trip', () => {
  test('calling scanJobs twice returns same IDs and statuses', async () => {
    const first = await scanJobs(FIXTURE_DIR);
    const second = await scanJobs(FIXTURE_DIR);

    expect(first.length).toBe(second.length);

    const sortedFirst  = [...first].map(j => j.id).sort();
    const sortedSecond = [...second].map(j => j.id).sort();
    expect(sortedFirst).toEqual(sortedSecond);

    // Statuses must also be identical for each ID
    const statusMap = (jobs: Job[]) =>
      Object.fromEntries(jobs.map(j => [j.id, j.status]));
    expect(statusMap(first)).toEqual(statusMap(second));
  });
});

// ---------------------------------------------------------------------------
// Metamorphic: adding one well-formed .md file increases count by exactly 1
// ---------------------------------------------------------------------------

describe('scanJobs metamorphic', () => {
  const tempDir = join(FIXTURE_DIR, '_temp-metamorphic-jobs');

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  test('adding one .md file increases job count by exactly 1', async () => {
    const before = await scanJobs(FIXTURE_DIR);
    // Count only .md-sourced prompt jobs
    const baseCount = before.filter(j => j.mdFile !== '').length;

    // Create a temp copy of the fixture dir and add one new file
    mkdirSync(tempDir, { recursive: true });
    // Copy existing fixtures
    const { readdirSync, copyFileSync } = await import('node:fs');
    for (const f of readdirSync(FIXTURE_DIR)) {
      if (f.endsWith('.md')) {
        copyFileSync(join(FIXTURE_DIR, f), join(tempDir, f));
      }
    }
    // Add one new well-formed .md file
    writeFileSync(
      join(tempDir, '2026-01-10-0800-metamorphic-delta.md'),
      makeJobMd('agenthq', 'analysis', true)
    );

    const after = await scanJobs(tempDir);
    const afterCount = after.filter(j => j.mdFile !== '').length;
    expect(afterCount).toBe(baseCount + 1);
  });

  test('fc: adding N files increases prompt-job count by exactly N', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        async (n) => {
          // Reset temp dir for each fc run
          try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
          mkdirSync(tempDir, { recursive: true });

          const { readdirSync, copyFileSync } = await import('node:fs');
          for (const f of readdirSync(FIXTURE_DIR)) {
            if (f.endsWith('.md')) {
              copyFileSync(join(FIXTURE_DIR, f), join(tempDir, f));
            }
          }

          const before = await scanJobs(tempDir);
          const baseCount = before.filter(j => j.mdFile !== '').length;

          for (let i = 0; i < n; i++) {
            writeFileSync(
              join(tempDir, `2026-01-10-${String(8 + i).padStart(2, '0')}00-fc-job-${i}.md`),
              makeJobMd('agenthq', 'analysis', false)
            );
          }

          const after = await scanJobs(tempDir);
          const afterCount = after.filter(j => j.mdFile !== '').length;
          return afterCount === baseCount + n;
        }
      ),
      { numRuns: 3 }
    );
  });
});
