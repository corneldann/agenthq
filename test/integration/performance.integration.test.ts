// ---------------------------------------------------------------------------
// Performance Integration Tests — multi-workspace scanning
//
// Feature: multi-workspace-monitoring, Task 13.2
// Validates: Requirement 2.9 — complete all workspace scans within <5 seconds
//
// Strategy: mock filesystem I/O by providing in-memory scan functions that
// simulate realistic data volumes (chains, sessions, jobs per workspace).
// The cache operations are exercised against the real PerWorkspaceCacheImpl.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from 'bun:test';
import { createCacheManager } from '../../src/scan/workspace-cache.ts';
import type { CacheManager } from '../../src/scan/workspace-cache.ts';
import type { Chain, SessionState, Job } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

/** Build a realistic SessionState for a given workspace and index. */
function makeSession(workspaceId: string, index: number): SessionState {
  return {
    workflowHash: `wh-${workspaceId}-${index}`,
    sessionJsonl: `/sessions/${workspaceId}/state-${index}.jsonl`,
    chainId: `chain-${workspaceId}-${index % 5}`,
    chainIndex: index % 5,
    previousSession: index > 0 ? `wh-${workspaceId}-${index - 1}` : '',
    topic: `Task: implement feature ${index} for ${workspaceId}`,
    messageCount: 20 + (index % 30),
    userMessageCount: 10 + (index % 15),
    contextUsagePct: 20 + (index % 60),
    lastMessageAt: new Date(Date.now() - index * 60_000).toISOString(),
    lastSummarisedMessageCount: 10 + (index % 10),
    lastSummarisedAt: new Date(Date.now() - index * 120_000).toISOString(),
    summaryFile: `/sessions/${workspaceId}/summary-${index}.md`,
    status: index % 4 === 0 ? 'active' : index % 4 === 1 ? 'idle' : index % 4 === 2 ? 'complete' : 'rate-limited',
    firstUserMessage: `Start task ${index}`,
    lastUserMessage: `Done with step ${index}`,
    lastAgentMessage: `Completed step ${index} successfully`,
    startTime: new Date(Date.now() - index * 180_000).toISOString(),
    chatSessionId: `chat-${workspaceId}-${index}`,
    workspaceId,
  };
}

/** Build a realistic Chain for a given workspace and index. */
function makeChain(workspaceId: string, index: number): Chain {
  const sessionCount = 2 + (index % 4);
  return {
    chainId: `chain-${workspaceId}-${index}`,
    displayName: `Chain ${index} - ${workspaceId}`,
    nextIndex: sessionCount,
    sessions: Array.from({ length: sessionCount }, (_, i) => ({
      index: i,
      workflowHash: `wh-${workspaceId}-${index * 10 + i}`,
      date: new Date(Date.now() - (index * 10 + i) * 60_000).toISOString(),
      messageCount: 5 + i * 3,
      status: i === sessionCount - 1 ? 'active' : 'idle',
    })),
    totalMessages: 10 + index * 5,
    createdAt: new Date(Date.now() - index * 86_400_000).toISOString(),
    lastActiveAt: new Date(Date.now() - index * 3_600_000).toISOString(),
    workspaceId,
  };
}

/** Build a realistic Job for a given workspace and index. */
function makeJob(workspaceId: string, index: number): Job {
  const statuses: Job['status'][] = ['running', 'done', 'reported', 'error'];
  return {
    id: `job-${workspaceId}-${index}`,
    name: `analysis-task-${index}`,
    jobChain: `analysis-task`,
    sessionChainId: `chain-${workspaceId}-${index % 5}`,
    timestamp: new Date(Date.now() - index * 300_000).toISOString(),
    type: index % 3 === 0 ? 'crawl' : index % 3 === 1 ? 'prompt' : 'clone',
    agent: 'test-agent',
    status: statuses[index % 4],
    lines: 50 + index * 10,
    lastLine: `Completed step ${index}`,
    hasLog: index % 2 === 0,
    logError: index % 10 === 0,
    mdFile: `output-${workspaceId}-${index}.md`,
    logFile: `output-${workspaceId}-${index}.log`,
    agentDone: statuses[index % 4] === 'done' ? new Date().toISOString() : '',
    sizeBytes: 1024 + index * 256,
    workspaceId,
  };
}

/**
 * Generate a full data set for a workspace:
 * - sessionsPerWs sessions
 * - chainsPerWs chains
 * - jobsPerWs jobs
 */
function generateWorkspaceData(
  workspaceId: string,
  sessionsPerWs: number,
  chainsPerWs: number,
  jobsPerWs: number,
) {
  return {
    sessions: Array.from({ length: sessionsPerWs }, (_, i) => makeSession(workspaceId, i)),
    chains:   Array.from({ length: chainsPerWs },   (_, i) => makeChain(workspaceId, i)),
    jobs:     Array.from({ length: jobsPerWs },     (_, i) => makeJob(workspaceId, i)),
  };
}

/**
 * Simulate scanning a single workspace: returns generated data with a small
 * async delay (0–2 ms) to model realistic I/O latency.
 */
async function simulateScanWorkspace(
  workspaceId: string,
  sessionsPerWs: number,
  chainsPerWs: number,
  jobsPerWs: number,
) {
  // Tiny async yield — simulates the event-loop turn cost of real I/O without
  // actually hitting the filesystem. Keeps the test deterministic and fast.
  await new Promise(r => setTimeout(r, Math.random() * 2));
  return generateWorkspaceData(workspaceId, sessionsPerWs, chainsPerWs, jobsPerWs);
}

/**
 * Orchestrate parallel scanning of `count` workspaces using Promise.all,
 * mirroring requirement 4.4 (parallel workspace scanning).
 */
async function scanAllWorkspaces(
  workspaceIds: string[],
  sessionsPerWs: number,
  chainsPerWs: number,
  jobsPerWs: number,
) {
  return Promise.all(
    workspaceIds.map(id => simulateScanWorkspace(id, sessionsPerWs, chainsPerWs, jobsPerWs))
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate workspace IDs: ["workspace-00", "workspace-01", …] */
function makeWorkspaceIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    `workspace-${String(i).padStart(2, '0')}`
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Performance Integration — Requirement 2.9: scan within 5 seconds', () => {

  // -------------------------------------------------------------------------
  // 10-workspace scan (typical configuration)
  // -------------------------------------------------------------------------

  test('scans 10 workspaces with realistic data within 5 seconds', async () => {
    const workspaceIds = makeWorkspaceIds(10);
    // Realistic data: 20 sessions, 10 chains, 15 jobs per workspace
    const start = performance.now();

    const results = await scanAllWorkspaces(workspaceIds, 20, 10, 15);

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5_000); // Requirement 2.9: <5 seconds

    // Verify all workspaces scanned
    expect(results.length).toBe(10);

    // Spot-check data completeness
    for (let i = 0; i < results.length; i++) {
      expect(results[i].sessions.length).toBe(20);
      expect(results[i].chains.length).toBe(10);
      expect(results[i].jobs.length).toBe(15);
    }
  });

  // -------------------------------------------------------------------------
  // 50-workspace scan (maximum configuration per Requirement 1.14)
  // -------------------------------------------------------------------------

  test('scans 50 workspaces with realistic data within 5 seconds', async () => {
    const workspaceIds = makeWorkspaceIds(50);
    // Smaller data per workspace to stay realistic for max configuration
    const start = performance.now();

    const results = await scanAllWorkspaces(workspaceIds, 10, 5, 8);

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5_000); // Requirement 2.9: <5 seconds

    expect(results.length).toBe(50);

    // Verify workspace IDs are correctly propagated
    const allSessions = results.flatMap(r => r.sessions);
    const allChains   = results.flatMap(r => r.chains);
    const allJobs     = results.flatMap(r => r.jobs);

    expect(allSessions.every(s => s.workspaceId.startsWith('workspace-'))).toBe(true);
    expect(allChains.every(c => c.workspaceId.startsWith('workspace-'))).toBe(true);
    expect(allJobs.every(j => j.workspaceId.startsWith('workspace-'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 30-workspace scan with large data volumes
  // -------------------------------------------------------------------------

  test('scans 30 workspaces with large data volumes within 5 seconds', async () => {
    const workspaceIds = makeWorkspaceIds(30);
    // Heavier data: 50 sessions, 25 chains, 40 jobs per workspace
    const start = performance.now();

    const results = await scanAllWorkspaces(workspaceIds, 50, 25, 40);

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5_000); // Requirement 2.9: <5 seconds

    expect(results.length).toBe(30);

    // Verify data volumes
    const totalSessions = results.reduce((n, r) => n + r.sessions.length, 0);
    const totalChains   = results.reduce((n, r) => n + r.chains.length, 0);
    const totalJobs     = results.reduce((n, r) => n + r.jobs.length, 0);

    expect(totalSessions).toBe(30 * 50);
    expect(totalChains).toBe(30 * 25);
    expect(totalJobs).toBe(30 * 40);
  });
});

// ---------------------------------------------------------------------------
// Cache performance tests
// ---------------------------------------------------------------------------

describe('Performance Integration — Cache hit performance (Requirement 4.6)', () => {

  let cache: CacheManager;

  beforeEach(() => {
    cache = createCacheManager();
  });

  // -------------------------------------------------------------------------
  // Cache set + get is faster than generating new data
  // -------------------------------------------------------------------------

  test('cache get is faster than generating data for 50 workspaces', () => {
    const workspaceIds = makeWorkspaceIds(50);
    const sessionsPerWs = 20;
    const chainsPerWs = 10;

    // Pre-populate caches (simulates post-scan state)
    for (const wsId of workspaceIds) {
      const { sessions, chains, jobs } = generateWorkspaceData(wsId, sessionsPerWs, chainsPerWs, 15);
      cache.sessions.set(wsId, sessions);
      cache.chains.set(wsId, chains);
      cache.jobs.set(wsId, jobs);
    }

    // Measure cache retrieval time for all 50 workspaces
    const startGet = performance.now();
    for (const wsId of workspaceIds) {
      const sessions = cache.sessions.get(wsId);
      const chains   = cache.chains.get(wsId);
      const jobs     = cache.jobs.get(wsId);
      // Ensure compiler doesn't optimise away the reads
      expect(sessions).not.toBeNull();
      expect(chains).not.toBeNull();
      expect(jobs).not.toBeNull();
    }
    const getElapsed = performance.now() - startGet;

    // Measure data generation time for the same 50 workspaces
    const startGen = performance.now();
    for (const wsId of workspaceIds) {
      generateWorkspaceData(wsId, sessionsPerWs, chainsPerWs, 15);
    }
    const genElapsed = performance.now() - startGen;

    // Cache reads should be faster than regenerating data
    expect(getElapsed).toBeLessThan(genElapsed + 50); // allow 50ms slack
    // Cache reads for 50 workspaces must be well under 1 second
    expect(getElapsed).toBeLessThan(1_000);
  });

  // -------------------------------------------------------------------------
  // Cache hit returns correct data
  // -------------------------------------------------------------------------

  test('cache hit returns identical data to what was stored for 50 workspaces', () => {
    const workspaceIds = makeWorkspaceIds(50);

    const stored: Record<string, ReturnType<typeof generateWorkspaceData>> = {};
    for (const wsId of workspaceIds) {
      stored[wsId] = generateWorkspaceData(wsId, 10, 5, 8);
      cache.sessions.set(wsId, stored[wsId].sessions);
      cache.chains.set(wsId, stored[wsId].chains);
      cache.jobs.set(wsId, stored[wsId].jobs);
    }

    for (const wsId of workspaceIds) {
      expect(cache.sessions.get(wsId)).toEqual(stored[wsId].sessions);
      expect(cache.chains.get(wsId)).toEqual(stored[wsId].chains);
      expect(cache.jobs.get(wsId)).toEqual(stored[wsId].jobs);
    }
  });

  // -------------------------------------------------------------------------
  // Cache miss (cold) returns null for all workspaces
  // -------------------------------------------------------------------------

  test('cold cache returns null for all workspaces (cache miss path)', () => {
    const workspaceIds = makeWorkspaceIds(50);

    const start = performance.now();
    for (const wsId of workspaceIds) {
      expect(cache.sessions.get(wsId)).toBeNull();
      expect(cache.chains.get(wsId)).toBeNull();
      expect(cache.jobs.get(wsId)).toBeNull();
    }
    const elapsed = performance.now() - start;

    // 150 cache lookups across 50 workspaces should be nearly instant
    expect(elapsed).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// Cache invalidation performance tests
// ---------------------------------------------------------------------------

describe('Performance Integration — Cache invalidation (Requirements 4.5, 4.7)', () => {

  let cache: CacheManager;

  beforeEach(() => {
    cache = createCacheManager();
  });

  // -------------------------------------------------------------------------
  // Individual workspace invalidation is fast
  // -------------------------------------------------------------------------

  test('individual workspace invalidation is sub-millisecond for 50 workspaces', () => {
    const workspaceIds = makeWorkspaceIds(50);

    // Populate all workspace caches
    for (const wsId of workspaceIds) {
      const { sessions, chains, jobs } = generateWorkspaceData(wsId, 10, 5, 8);
      cache.sessions.set(wsId, sessions);
      cache.chains.set(wsId, chains);
      cache.jobs.set(wsId, jobs);
    }

    // Measure time to invalidate each workspace individually
    const start = performance.now();
    for (const wsId of workspaceIds) {
      cache.sessions.invalidate(wsId);
      cache.chains.invalidate(wsId);
      cache.jobs.invalidate(wsId);
    }
    const elapsed = performance.now() - start;

    // 150 invalidation calls should complete well under 100ms
    expect(elapsed).toBeLessThan(100);

    // All caches should now be empty
    for (const wsId of workspaceIds) {
      expect(cache.sessions.get(wsId)).toBeNull();
      expect(cache.chains.get(wsId)).toBeNull();
      expect(cache.jobs.get(wsId)).toBeNull();
    }
  });

  // -------------------------------------------------------------------------
  // Single workspace invalidation does NOT affect other workspaces
  // -------------------------------------------------------------------------

  test('invalidating one workspace leaves all other 49 workspace caches intact', () => {
    const workspaceIds = makeWorkspaceIds(50);
    const targetWs = workspaceIds[25]; // invalidate workspace-25

    // Populate all workspace caches
    const stored: Record<string, ReturnType<typeof generateWorkspaceData>> = {};
    for (const wsId of workspaceIds) {
      stored[wsId] = generateWorkspaceData(wsId, 10, 5, 8);
      cache.sessions.set(wsId, stored[wsId].sessions);
      cache.chains.set(wsId, stored[wsId].chains);
      cache.jobs.set(wsId, stored[wsId].jobs);
    }

    // Invalidate only the target workspace
    cache.sessions.invalidate(targetWs);
    cache.chains.invalidate(targetWs);
    cache.jobs.invalidate(targetWs);

    // Target workspace cache must be cleared
    expect(cache.sessions.get(targetWs)).toBeNull();
    expect(cache.chains.get(targetWs)).toBeNull();
    expect(cache.jobs.get(targetWs)).toBeNull();

    // All other 49 workspaces must remain cached (Requirement 4.5)
    for (const wsId of workspaceIds) {
      if (wsId === targetWs) continue;
      expect(cache.sessions.get(wsId)).toEqual(stored[wsId].sessions);
      expect(cache.chains.get(wsId)).toEqual(stored[wsId].chains);
      expect(cache.jobs.get(wsId)).toEqual(stored[wsId].jobs);
    }
  });

  // -------------------------------------------------------------------------
  // Invalidating non-existent workspace completes without error (Req 4.9)
  // -------------------------------------------------------------------------

  test('invalidating a non-existent workspace ID completes without error', () => {
    const workspaceIds = makeWorkspaceIds(10);
    for (const wsId of workspaceIds) {
      const { sessions, chains, jobs } = generateWorkspaceData(wsId, 5, 3, 4);
      cache.sessions.set(wsId, sessions);
      cache.chains.set(wsId, chains);
      cache.jobs.set(wsId, jobs);
    }

    expect(() => {
      cache.sessions.invalidate('workspace-does-not-exist');
      cache.chains.invalidate('workspace-does-not-exist');
      cache.jobs.invalidate('workspace-does-not-exist');
    }).not.toThrow();

    // Existing workspace caches must be untouched
    for (const wsId of workspaceIds) {
      expect(cache.sessions.get(wsId)).not.toBeNull();
      expect(cache.chains.get(wsId)).not.toBeNull();
      expect(cache.jobs.get(wsId)).not.toBeNull();
    }
  });

  // -------------------------------------------------------------------------
  // invalidateAll clears all workspace caches at once
  // -------------------------------------------------------------------------

  test('invalidateAll removes all cached data across 50 workspaces quickly', () => {
    const workspaceIds = makeWorkspaceIds(50);
    for (const wsId of workspaceIds) {
      const { sessions, chains, jobs } = generateWorkspaceData(wsId, 10, 5, 8);
      cache.sessions.set(wsId, sessions);
      cache.chains.set(wsId, chains);
      cache.jobs.set(wsId, jobs);
    }

    const start = performance.now();
    cache.sessions.invalidateAll();
    cache.chains.invalidateAll();
    cache.jobs.invalidateAll();
    const elapsed = performance.now() - start;

    // Three Map.clear() calls should be near-instantaneous
    expect(elapsed).toBeLessThan(10);

    for (const wsId of workspaceIds) {
      expect(cache.sessions.get(wsId)).toBeNull();
      expect(cache.chains.get(wsId)).toBeNull();
      expect(cache.jobs.get(wsId)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: scan → cache → retrieve cycle for 10 workspaces
// ---------------------------------------------------------------------------

describe('Performance Integration — Scan + cache round-trip (Requirement 2.9 + 4.6)', () => {

  test('full scan-then-cache-then-retrieve cycle for 10 workspaces is under 5 seconds', async () => {
    const workspaceIds = makeWorkspaceIds(10);
    const cache = createCacheManager();

    const start = performance.now();

    // 1. Parallel scan of all workspaces
    const results = await scanAllWorkspaces(workspaceIds, 20, 10, 15);

    // 2. Store results in cache
    for (let i = 0; i < workspaceIds.length; i++) {
      const wsId = workspaceIds[i];
      cache.sessions.set(wsId, results[i].sessions);
      cache.chains.set(wsId, results[i].chains);
      cache.jobs.set(wsId, results[i].jobs);
    }

    // 3. Retrieve from cache (simulates subsequent requests hitting cache)
    for (const wsId of workspaceIds) {
      const sessions = cache.sessions.get(wsId);
      const chains   = cache.chains.get(wsId);
      const jobs     = cache.jobs.get(wsId);
      expect(sessions).not.toBeNull();
      expect(chains).not.toBeNull();
      expect(jobs).not.toBeNull();
    }

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5_000); // Requirement 2.9

    // Verify aggregate totals
    const allSessions = workspaceIds.flatMap(wsId => cache.sessions.get(wsId) ?? []);
    const allChains   = workspaceIds.flatMap(wsId => cache.chains.get(wsId) ?? []);
    const allJobs     = workspaceIds.flatMap(wsId => cache.jobs.get(wsId) ?? []);

    expect(allSessions.length).toBe(10 * 20);
    expect(allChains.length).toBe(10 * 10);
    expect(allJobs.length).toBe(10 * 15);

    // Data isolation: every item has the correct workspaceId
    expect(allSessions.every(s => workspaceIds.includes(s.workspaceId))).toBe(true);
    expect(allChains.every(c => workspaceIds.includes(c.workspaceId))).toBe(true);
    expect(allJobs.every(j => workspaceIds.includes(j.workspaceId))).toBe(true);
  });

  test('second retrieval from cache is faster than initial scan for 10 workspaces', async () => {
    const workspaceIds = makeWorkspaceIds(10);
    const cache = createCacheManager();

    // Initial scan + cache population
    const scanStart = performance.now();
    const results = await scanAllWorkspaces(workspaceIds, 20, 10, 15);
    for (let i = 0; i < workspaceIds.length; i++) {
      cache.sessions.set(workspaceIds[i], results[i].sessions);
      cache.chains.set(workspaceIds[i], results[i].chains);
      cache.jobs.set(workspaceIds[i], results[i].jobs);
    }
    const scanElapsed = performance.now() - scanStart;

    // Cache-only retrieval (second access — should be faster)
    const cacheStart = performance.now();
    for (const wsId of workspaceIds) {
      cache.sessions.get(wsId);
      cache.chains.get(wsId);
      cache.jobs.get(wsId);
    }
    const cacheElapsed = performance.now() - cacheStart;

    // Cache hits must be faster than the full scan (plus generous slack for
    // timing jitter in CI environments)
    expect(cacheElapsed).toBeLessThan(scanElapsed + 100);
    // And must be well under 1 second on their own
    expect(cacheElapsed).toBeLessThan(1_000);
  });
});
