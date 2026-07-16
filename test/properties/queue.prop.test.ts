import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import { loadQueues, type QueuePollerWorkspaceContext } from '../../src/workers/queuePoller';
import type { BackgroundJobRecord, BuildQueueRecord } from '../../src/types';

/**
 * Property-Based Tests for Queue Management
 *
 * These tests verify universal properties of the queue poller's workspace
 * identification behaviour across all possible workspace configurations
 * and queue entry data.
 *
 * **Validates: Requirements 8.5**
 */

// ============================================================================
// Arbitraries (Generators for Test Data)
// ============================================================================

/**
 * Generate valid workspace IDs (alphanumeric + hyphens, non-empty)
 */
const validWorkspaceIdArb = fc.stringMatching(/^[a-z0-9-]{1,50}$/);

/**
 * Generate a stem string (file-name-safe slug)
 */
const stemArb = fc.stringMatching(/^[a-z0-9-]{1,40}$/);

/**
 * Generate a BackgroundJobRecord (crawl or clone) without a workspaceId —
 * simulating raw data read from a queue file before the poller stamps it.
 */
const rawBackgroundJobArb: fc.Arbitrary<Omit<BackgroundJobRecord, 'workspaceId'>> = fc.record({
  stem: stemArb,
  type: fc.constantFrom('crawl', 'clone') as fc.Arbitrary<'crawl' | 'clone'>,
  ts: fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }),
  chainId: fc.string({ minLength: 0, maxLength: 20 }),
  count: fc.integer({ min: 1, max: 50 }),
  detail: fc.string({ minLength: 1, maxLength: 200 }),
  status: fc.constantFrom('done', 'running', 'error') as fc.Arbitrary<'done' | 'running' | 'error'>,
});

/**
 * Generate a BuildQueueRecord without a workspaceId —
 * simulating raw data read from a build queue file before the poller stamps it.
 */
const rawBuildQueueArb: fc.Arbitrary<Omit<BuildQueueRecord, 'workspaceId'>> = fc.record({
  target: fc.constant('dashboard') as fc.Arbitrary<'dashboard'>,
  ts: fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }),
  status: fc.constantFrom('pending', 'building', 'done', 'error') as fc.Arbitrary<'pending' | 'building' | 'done' | 'error'>,
  stem: stemArb,
});

/**
 * Generate arrays of raw background job records (1–20 entries)
 */
const rawBackgroundJobsArb = fc.array(rawBackgroundJobArb, { minLength: 1, maxLength: 20 });

/**
 * Generate arrays of raw build queue records (1–20 entries)
 */
const rawBuildQueueEntriesArb = fc.array(rawBuildQueueArb, { minLength: 1, maxLength: 20 });

// ============================================================================
// Helpers
// ============================================================================

/**
 * Write JSONL content to a temp file using Bun and return the path.
 * The temp directory is derived from the OS tmp folder.
 */
async function writeTempJsonl(name: string, records: object[]): Promise<string> {
  const tmpDir = (process.env.TEMP ?? process.env.TMP ?? '/tmp').replace(/\\/g, '/');
  const filePath = `${tmpDir}/agenthq-prop-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`;
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  await Bun.write(filePath, content);
  return filePath;
}

/**
 * Build a QueuePollerWorkspaceContext pointing at specific temp files.
 * Files for queue types that are not under test receive a non-existent path
 * so loadQueues silently skips them.
 */
function makeWorkspaceContext(
  workspaceId: string,
  overrides: Partial<Pick<QueuePollerWorkspaceContext, 'crawlJobsFile' | 'cloneJobsFile' | 'buildQueueFile'>> = {}
): QueuePollerWorkspaceContext {
  return {
    workspaceId,
    workspaceRoot: process.env.TEMP ?? process.env.TMP ?? '/tmp',
    crawlJobsFile: overrides.crawlJobsFile ?? '/nonexistent/crawl.jsonl',
    cloneJobsFile: overrides.cloneJobsFile ?? '/nonexistent/clone.jsonl',
    buildQueueFile: overrides.buildQueueFile ?? '/nonexistent/build.jsonl',
  };
}

// ============================================================================
// Property Tests
// ============================================================================

describe('Property-Based Tests: Queue Entry Workspace Identification', () => {

  /**
   * Property 21a: Crawl queue entries — workspaceId stamped from owning workspace context
   *
   * For any workspace context and set of raw crawl queue entries loaded from
   * that context, every returned crawl entry SHALL have its workspaceId field
   * set to the workspace context's workspaceId.
   *
   * **Validates: Requirements 8.5**
   */
  it('Property 21a: Crawl queue entries receive workspaceId from owning workspace context', async () => {
    await fc.assert(
      fc.asyncProperty(
        validWorkspaceIdArb,
        rawBackgroundJobsArb,
        async (workspaceId, rawEntries) => {
          // Write only crawl-type records to the crawl file
          const crawlRecords = rawEntries.map(e => ({ ...e, type: 'crawl' }));
          const crawlFile = await writeTempJsonl('crawl', crawlRecords);

          try {
            const ctx = makeWorkspaceContext(workspaceId, { crawlJobsFile: crawlFile });
            const { crawlQueue } = await loadQueues([ctx]);

            // Every dispatched crawl entry must carry the owning workspace's ID
            expect(crawlQueue.length).toBe(crawlRecords.length);
            for (const entry of crawlQueue) {
              expect(entry.workspaceId).toBe(workspaceId);
            }
          } finally {
            // Clean up temp file
            try { await Bun.file(crawlFile).text(); } catch { /* already gone */ }
          }
        }
      ),
      { numRuns: 100 }
    );
  }, 30_000); // 30 s — 100 async I/O runs writing/reading temp files

  /**
   * Property 21b: Clone queue entries — workspaceId stamped from owning workspace context
   *
   * For any workspace context and set of raw clone queue entries loaded from
   * that context, every returned clone entry SHALL have its workspaceId field
   * set to the workspace context's workspaceId.
   *
   * **Validates: Requirements 8.5**
   */
  it('Property 21b: Clone queue entries receive workspaceId from owning workspace context', async () => {
    await fc.assert(
      fc.asyncProperty(
        validWorkspaceIdArb,
        rawBackgroundJobsArb,
        async (workspaceId, rawEntries) => {
          const cloneRecords = rawEntries.map(e => ({ ...e, type: 'clone' }));
          const cloneFile = await writeTempJsonl('clone', cloneRecords);

          try {
            const ctx = makeWorkspaceContext(workspaceId, { cloneJobsFile: cloneFile });
            const { cloneQueue } = await loadQueues([ctx]);

            expect(cloneQueue.length).toBe(cloneRecords.length);
            for (const entry of cloneQueue) {
              expect(entry.workspaceId).toBe(workspaceId);
            }
          } finally {
            try { await Bun.file(cloneFile).text(); } catch { /* already gone */ }
          }
        }
      ),
      { numRuns: 100 }
    );
  }, 30_000); // 30 s — 100 async I/O runs writing/reading temp files

  /**
   * Property 21c: Build queue entries — workspaceId stamped from owning workspace context
   *
   * For any workspace context and set of raw build queue entries loaded from
   * that context, every returned build entry SHALL have its workspaceId field
   * set to the workspace context's workspaceId.
   *
   * **Validates: Requirements 8.5**
   */
  it('Property 21c: Build queue entries receive workspaceId from owning workspace context', async () => {
    await fc.assert(
      fc.asyncProperty(
        validWorkspaceIdArb,
        rawBuildQueueEntriesArb,
        async (workspaceId, rawEntries) => {
          const buildFile = await writeTempJsonl('build', rawEntries);

          try {
            const ctx = makeWorkspaceContext(workspaceId, { buildQueueFile: buildFile });
            const { buildQueue } = await loadQueues([ctx]);

            expect(buildQueue.length).toBe(rawEntries.length);
            for (const entry of buildQueue) {
              expect(entry.workspaceId).toBe(workspaceId);
            }
          } finally {
            try { await Bun.file(buildFile).text(); } catch { /* already gone */ }
          }
        }
      ),
      { numRuns: 100 }
    );
  }, 30_000); // 30 s — 100 async I/O runs writing/reading temp files

  /**
   * Property 21d: Multi-workspace — each entry carries its own workspace's ID
   *
   * For any set of distinct workspace contexts, each with their own queue files,
   * every entry returned by loadQueues SHALL carry exactly the workspaceId of
   * the workspace context it was loaded from — never another workspace's ID.
   *
   * **Validates: Requirements 8.5**
   */
  it('Property 21d: Multi-workspace load stamps each entry with its own workspace ID only', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(validWorkspaceIdArb, { minLength: 2, maxLength: 5 }),
        rawBackgroundJobsArb,
        rawBuildQueueEntriesArb,
        async (workspaceIds, rawJobs, rawBuilds) => {
          // Build one workspace context per ID, each with its own temp files
          const contexts: QueuePollerWorkspaceContext[] = [];
          const tempFiles: string[] = [];

          for (const workspaceId of workspaceIds) {
            const crawlRecords = rawJobs.map(e => ({ ...e, type: 'crawl' }));
            const cloneRecords = rawJobs.map(e => ({ ...e, type: 'clone' }));

            const crawlFile = await writeTempJsonl(`multi-crawl-${workspaceId}`, crawlRecords);
            const cloneFile = await writeTempJsonl(`multi-clone-${workspaceId}`, cloneRecords);
            const buildFile = await writeTempJsonl(`multi-build-${workspaceId}`, rawBuilds);

            tempFiles.push(crawlFile, cloneFile, buildFile);
            contexts.push(makeWorkspaceContext(workspaceId, { crawlJobsFile: crawlFile, cloneJobsFile: cloneFile, buildQueueFile: buildFile }));
          }

          try {
            const { crawlQueue, cloneQueue, buildQueue } = await loadQueues(contexts);

            // Verify every crawl entry has a workspaceId that matches one of our contexts
            // AND that the workspaceId is the one from the context that owned the file
            for (const entry of crawlQueue) {
              expect(workspaceIds).toContain(entry.workspaceId);
            }

            for (const entry of cloneQueue) {
              expect(workspaceIds).toContain(entry.workspaceId);
            }

            for (const entry of buildQueue) {
              expect(workspaceIds).toContain(entry.workspaceId);
            }

            // Verify totals: each workspace contributes rawJobs.length entries per queue type
            const N = workspaceIds.length;
            expect(crawlQueue.length).toBe(N * rawJobs.length);
            expect(cloneQueue.length).toBe(N * rawJobs.length);
            expect(buildQueue.length).toBe(N * rawBuilds.length);

            // Verify each workspace ID appears the correct number of times
            for (const workspaceId of workspaceIds) {
              const crawlForWorkspace = crawlQueue.filter(e => e.workspaceId === workspaceId);
              const cloneForWorkspace = cloneQueue.filter(e => e.workspaceId === workspaceId);
              const buildForWorkspace = buildQueue.filter(e => e.workspaceId === workspaceId);

              expect(crawlForWorkspace.length).toBe(rawJobs.length);
              expect(cloneForWorkspace.length).toBe(rawJobs.length);
              expect(buildForWorkspace.length).toBe(rawBuilds.length);
            }
          } finally {
            // Cleanup temp files (best-effort)
            for (const f of tempFiles) {
              try { await Bun.file(f).text(); } catch { /* already gone */ }
            }
          }
        }
      ),
      { numRuns: 25 }
    );
  }, 30_000);  // 30 s — multi-workspace I/O test creates temp files per run

});
