import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import type { Chain, Job } from '../../src/types';
import type { WorkspaceConfig } from '../../src/config/workspace-config';

// NOTE: sortWorkspaceMetrics and WorkspaceMetrics are inlined here to avoid
// importing dashboard.ts which carries browser side-effects (state.ts →
// localStorage). This mirrors the pattern used in dashboard.test.ts.

interface WorkspaceMetrics {
  workspaceId: string;
  displayName: string;
  totalMessages: number;
  contextUsagePct: number;
  activeSessions: number;
  pendingQueueItems: number;
  hasAttentionItems: boolean;
}

/**
 * Sorts workspace metrics by activity level descending.
 * Primary: totalMessages (descending).
 * Secondary: displayName alphabetically (ascending) when messages are equal.
 * Mirrors sortWorkspaceMetrics in src/dashboard/pages/dashboard.ts.
 */
function sortWorkspaceMetrics(metrics: WorkspaceMetrics[]): WorkspaceMetrics[] {
  return [...metrics].sort((a, b) => {
    if (b.totalMessages !== a.totalMessages) {
      return b.totalMessages - a.totalMessages; // descending
    }
    // secondary: alphabetical by displayName
    return a.displayName.localeCompare(b.displayName);
  });
}

/**
 * Property-Based Tests for Dashboard Metrics
 *
 * These tests verify workspace metrics calculation, sort correctness,
 * and attention item detection.
 *
 * **Validates: Requirements 10.1-10.7**
 */

// ============================================================================
// Arbitraries (Generators for Test Data)
// ============================================================================

const validWorkspaceIdArb = fc.stringMatching(/^[a-z0-9-]{1,50}$/);

const workspaceConfigArb: fc.Arbitrary<WorkspaceConfig> = fc.record({
  id: validWorkspaceIdArb,
  OUTPUT_DIR: fc.constant('/test/output'),
  SESSIONS_DIR: fc.constant('/test/sessions'),
  WORKSPACE_ROOT: fc.constant('/test/root'),
  CHAINS_DIR: fc.constant('/test/chains'),
  PROMPT_OUTPUT_DIR: fc.constant('/test/output'),
});

/** Build a minimal Chain with specific totalMessages for metrics testing. */
function makeChain(
  workspaceId: string,
  totalMessages: number,
  opts: {
    isActive?: boolean;
    contextUsagePct?: number;
    unsummarisedDelta?: number;
  } = {}
): Chain {
  const { isActive = false, contextUsagePct = 0, unsummarisedDelta = 0 } = opts;
  return {
    chainId: `chain-${Math.random().toString(36).slice(2)}`,
    displayName: 'Test Chain',
    nextIndex: 1,
    sessions: [],
    totalMessages,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    latestSession: isActive || contextUsagePct > 0
      ? {
          index: 0,
          workflowHash: 'abc12345',
          date: new Date().toISOString(),
          messageCount: totalMessages,
          status: isActive ? 'active' : 'idle',
          contextUsagePct,
          lastSummarisedMessageCount: totalMessages - unsummarisedDelta,
        }
      : undefined,
    unsummarisedDelta,
    workspaceId,
  } as unknown as Chain;
}

/** Build a minimal Job for metrics testing. */
function makeJob(
  workspaceId: string,
  status: 'running' | 'done' | 'error' | 'reported'
): Job {
  return {
    id: `job-${Math.random().toString(36).slice(2)}`,
    name: 'Test Job',
    jobChain: 'chain',
    sessionChainId: 'chain-123',
    timestamp: new Date().toISOString(),
    type: 'build',
    agent: 'agent1',
    status,
    lines: 0,
    lastLine: '',
    hasLog: false,
    logError: false,
    mdFile: '',
    logFile: '',
    agentDone: new Date().toISOString(),
    sizeBytes: 0,
    workspaceId,
  } as Job;
}

// ============================================================================
// Inline computeWorkspaceMetrics (mirrors dashboard.ts logic for testing)
// ============================================================================

/**
 * Computes WorkspaceMetrics for a single workspace from its chains and jobs.
 * Mirrors the logic inside computeWorkspaceMetrics() in dashboard.ts.
 */
function computeMetricsForWorkspace(
  workspaceId: string,
  displayName: string,
  chains: Chain[],
  jobs: Job[],
): WorkspaceMetrics {
  const wsChains = chains.filter(c => c.workspaceId === workspaceId);
  const wsJobs = jobs.filter(j => j.workspaceId === workspaceId);

  // Req 10.1: total messages = sum of all session messages
  const totalMessages = wsChains.reduce((sum, c) => sum + (c.totalMessages ?? 0), 0);

  // Req 10.2: context usage % = average of latest session context pcts
  const sessionsWithContext = wsChains
    .map(c => (c as any).latestSession?.contextUsagePct ?? null)
    .filter((pct): pct is number => pct !== null);
  const contextUsagePct = sessionsWithContext.length > 0
    ? Math.round(sessionsWithContext.reduce((s, p) => s + p, 0) / sessionsWithContext.length)
    : 0;

  // Req 10.3: active sessions = count of sessions with status "active"
  const activeSessions = wsChains.filter(
    c => (c as any).latestSession?.status === 'active',
  ).length;

  // Req 10.4: pending queue items = count of jobs with status "running"
  const pendingQueueItems = wsJobs.filter(j => j.status === 'running').length;

  // Req 10.7: attention items = unsummarised sessions OR queue errors
  const hasUnsummarisedSessions = wsChains.some(c => ((c as any).unsummarisedDelta ?? 0) > 0);
  const hasQueueErrors = wsJobs.some(j => j.status === 'error');
  const hasAttentionItems = hasUnsummarisedSessions || hasQueueErrors;

  return {
    workspaceId,
    displayName,
    totalMessages,
    contextUsagePct,
    activeSessions,
    pendingQueueItems,
    hasAttentionItems,
  };
}

// ============================================================================
// Property 24: Workspace Metrics Calculation Correctness
// ============================================================================

describe('Property-Based Tests: Workspace Metrics Calculation and Comparison', () => {

  describe('Property 24: Workspace Metrics Calculation Correctness', () => {
    /**
     * Total messages = sum of all chain totalMessages for the workspace.
     * Validates: Requirement 10.1
     */
    it('total messages equals sum of chain message counts', () => {
      fc.assert(
        fc.property(
          validWorkspaceIdArb,
          fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 0, maxLength: 20 }),
          (workspaceId, messageCounts) => {
            const chains = messageCounts.map(count => makeChain(workspaceId, count));
            const jobs: Job[] = [];

            const metrics = computeMetricsForWorkspace(workspaceId, workspaceId, chains, jobs);

            const expectedTotal = messageCounts.reduce((sum, c) => sum + c, 0);
            expect(metrics.totalMessages).toBe(expectedTotal);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Total messages is 0 when workspace has no chains.
     * Validates: Requirement 10.1
     */
    it('total messages is 0 for workspace with no chains', () => {
      fc.assert(
        fc.property(
          validWorkspaceIdArb,
          (workspaceId) => {
            const metrics = computeMetricsForWorkspace(workspaceId, workspaceId, [], []);
            expect(metrics.totalMessages).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Context usage % = average of latest session context percentages.
     * Only chains with a latestSession contribute to the average.
     * Validates: Requirement 10.2
     */
    it('context usage is average of latest session context percentages', () => {
      fc.assert(
        fc.property(
          validWorkspaceIdArb,
          fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 20 }),
          (workspaceId, contextPcts) => {
            // Create chains with explicit latestSession to ensure context is tracked.
            // makeChain only creates a latestSession when isActive=true or contextUsagePct > 0.
            // Force creation by using isActive=true for all chains.
            const chains = contextPcts.map(pct => makeChain(workspaceId, 1, { isActive: true, contextUsagePct: pct }));
            const metrics = computeMetricsForWorkspace(workspaceId, workspaceId, chains, []);

            // Average of all provided context percentages
            const expectedAvg = Math.round(contextPcts.reduce((s, p) => s + p, 0) / contextPcts.length);
            expect(metrics.contextUsagePct).toBe(expectedAvg);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Active sessions = count of chains with latestSession.status === "active".
     * Validates: Requirement 10.3
     */
    it('active sessions counts only chains with active status', () => {
      fc.assert(
        fc.property(
          validWorkspaceIdArb,
          fc.integer({ min: 0, max: 10 }),
          fc.integer({ min: 0, max: 10 }),
          (workspaceId, activeCount, inactiveCount) => {
            const activeChains = Array.from({ length: activeCount }, () =>
              makeChain(workspaceId, 1, { isActive: true })
            );
            const inactiveChains = Array.from({ length: inactiveCount }, () =>
              makeChain(workspaceId, 1, { isActive: false })
            );
            const allChains = [...activeChains, ...inactiveChains];
            const metrics = computeMetricsForWorkspace(workspaceId, workspaceId, allChains, []);

            expect(metrics.activeSessions).toBe(activeCount);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Pending queue items = count of jobs with status "running".
     * Validates: Requirement 10.4
     */
    it('pending queue items counts only running jobs', () => {
      fc.assert(
        fc.property(
          validWorkspaceIdArb,
          fc.integer({ min: 0, max: 10 }),
          fc.integer({ min: 0, max: 10 }),
          (workspaceId, runningCount, otherCount) => {
            const runningJobs = Array.from({ length: runningCount }, () => makeJob(workspaceId, 'running'));
            const otherJobs = Array.from({ length: otherCount }, () => makeJob(workspaceId, 'done'));
            const allJobs = [...runningJobs, ...otherJobs];
            const metrics = computeMetricsForWorkspace(workspaceId, workspaceId, [], allJobs);

            expect(metrics.pendingQueueItems).toBe(runningCount);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Metrics only include data for the specified workspace (not other workspaces).
     * Validates: Requirements 10.1-10.4
     */
    it('metrics only include data belonging to the target workspace', () => {
      fc.assert(
        fc.property(
          fc.tuple(validWorkspaceIdArb, validWorkspaceIdArb).filter(([a, b]) => a !== b),
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: 1, max: 10 }),
          ([workspaceA, workspaceB], chainCountA, chainCountB) => {
            const chainsA = Array.from({ length: chainCountA }, () => makeChain(workspaceA, 5));
            const chainsB = Array.from({ length: chainCountB }, () => makeChain(workspaceB, 10));
            const allChains = [...chainsA, ...chainsB];

            const metricsA = computeMetricsForWorkspace(workspaceA, workspaceA, allChains, []);
            const metricsB = computeMetricsForWorkspace(workspaceB, workspaceB, allChains, []);

            // Each workspace's metrics only reflect its own chains
            expect(metricsA.totalMessages).toBe(chainCountA * 5);
            expect(metricsB.totalMessages).toBe(chainCountB * 10);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // ============================================================================
  // Property 25: Workspace Comparison Sort Correctness
  // ============================================================================

  describe('Property 25: Workspace Comparison Sort Correctness', () => {

    /** Build a WorkspaceMetrics object for sort testing. */
    function makeMetrics(
      workspaceId: string,
      totalMessages: number,
      displayName?: string
    ): WorkspaceMetrics {
      return {
        workspaceId,
        displayName: displayName ?? workspaceId,
        totalMessages,
        contextUsagePct: 0,
        activeSessions: 0,
        pendingQueueItems: 0,
        hasAttentionItems: false,
      };
    }

    const workspaceMetricsArb = fc.record({
      workspaceId: validWorkspaceIdArb,
      displayName: fc.string({ minLength: 1, maxLength: 30 }),
      totalMessages: fc.integer({ min: 0, max: 10000 }),
      contextUsagePct: fc.integer({ min: 0, max: 100 }),
      activeSessions: fc.integer({ min: 0, max: 20 }),
      pendingQueueItems: fc.integer({ min: 0, max: 50 }),
      hasAttentionItems: fc.boolean(),
    });

    /**
     * sortWorkspaceMetrics returns sorted results in descending order by totalMessages.
     * Validates: Requirement 10.6
     */
    it('sort produces descending order by totalMessages', () => {
      fc.assert(
        fc.property(
          fc.array(workspaceMetricsArb, { minLength: 0, maxLength: 20 }),
          (metrics) => {
            const sorted = sortWorkspaceMetrics(metrics);

            // Verify descending order
            for (let i = 0; i < sorted.length - 1; i++) {
              expect(sorted[i].totalMessages).toBeGreaterThanOrEqual(sorted[i + 1].totalMessages);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Sort preserves all items (no items dropped or duplicated).
     * Validates: Requirement 10.6
     */
    it('sort preserves all items without loss or duplication', () => {
      fc.assert(
        fc.property(
          fc.array(workspaceMetricsArb, { minLength: 0, maxLength: 20 }),
          (metrics) => {
            const sorted = sortWorkspaceMetrics(metrics);

            // Same number of items
            expect(sorted.length).toBe(metrics.length);

            // All original items present
            for (const item of metrics) {
              expect(sorted).toContain(item);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Sort does not mutate the original array.
     * Validates: Requirement 10.6
     */
    it('sort returns new array without mutating the original', () => {
      fc.assert(
        fc.property(
          fc.array(workspaceMetricsArb, { minLength: 2, maxLength: 10 }),
          (metrics) => {
            const originalOrder = [...metrics];
            const sorted = sortWorkspaceMetrics(metrics);

            // Original array unchanged
            expect(metrics).toEqual(originalOrder);

            // Return value is a different reference
            expect(sorted).not.toBe(metrics);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Secondary sort: workspaces with equal totalMessages sorted alphabetically by displayName.
     * Validates: Requirement 10.6.1
     */
    it('applies alphabetical secondary sort when totalMessages are equal', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({ name: fc.string({ minLength: 1, maxLength: 20 }), msg: fc.constant(100) }),
            { minLength: 2, maxLength: 10 }
          ),
          (entries) => {
            // Ensure unique names to avoid ambiguity
            const uniqueEntries = Array.from(
              new Map(entries.map(e => [e.name, e])).values()
            );
            fc.pre(uniqueEntries.length >= 2);

            const metrics = uniqueEntries.map(e => makeMetrics(e.name, e.msg, e.name));
            const sorted = sortWorkspaceMetrics(metrics);

            // All have same totalMessages, so secondary sort should be alphabetical
            for (let i = 0; i < sorted.length - 1; i++) {
              expect(sorted[i].totalMessages).toBe(sorted[i + 1].totalMessages);
              expect(sorted[i].displayName.localeCompare(sorted[i + 1].displayName)).toBeLessThanOrEqual(0);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Primary sort by totalMessages takes precedence over displayName.
     * Validates: Requirement 10.6
     */
    it('primary sort by totalMessages takes precedence over alphabetical order', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 1000 }),
          (baseMessages) => {
            // Workspace "z-workspace" has more messages than "a-workspace"
            const highActivity = makeMetrics('z-workspace', baseMessages + 100, 'z-workspace');
            const lowActivity = makeMetrics('a-workspace', baseMessages, 'a-workspace');

            const sorted = sortWorkspaceMetrics([lowActivity, highActivity]);

            // Even though "a-workspace" comes first alphabetically,
            // "z-workspace" should be first due to higher message count
            expect(sorted[0].workspaceId).toBe('z-workspace');
            expect(sorted[1].workspaceId).toBe('a-workspace');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // ============================================================================
  // Property 26: Attention Item Detection
  // ============================================================================

  describe('Property 26: Attention Item Detection', () => {

    /**
     * Workspace has attention items if ANY session has unsummarised messages.
     * Validates: Requirement 10.7
     */
    it('detects attention items when workspace has unsummarised sessions', () => {
      fc.assert(
        fc.property(
          validWorkspaceIdArb,
          fc.integer({ min: 1, max: 100 }),
          (workspaceId, unsummarisedDelta) => {
            const chainWithUnsummarised = makeChain(workspaceId, 10, { unsummarisedDelta });
            const metrics = computeMetricsForWorkspace(workspaceId, workspaceId, [chainWithUnsummarised], []);

            // Should be flagged
            expect(metrics.hasAttentionItems).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Workspace has attention items if ANY job has status "error".
     * Validates: Requirement 10.7
     */
    it('detects attention items when workspace has queue errors', () => {
      fc.assert(
        fc.property(
          validWorkspaceIdArb,
          (workspaceId) => {
            const errorJob = makeJob(workspaceId, 'error');
            const metrics = computeMetricsForWorkspace(workspaceId, workspaceId, [], [errorJob]);

            // Should be flagged
            expect(metrics.hasAttentionItems).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Workspace has attention items if BOTH unsummarised sessions AND queue errors exist.
     * Validates: Requirement 10.7
     */
    it('detects attention items when BOTH unsummarised sessions and queue errors present', () => {
      fc.assert(
        fc.property(
          validWorkspaceIdArb,
          fc.integer({ min: 1, max: 50 }),
          (workspaceId, unsummarisedDelta) => {
            const chainWithUnsummarised = makeChain(workspaceId, 10, { unsummarisedDelta });
            const errorJob = makeJob(workspaceId, 'error');
            const metrics = computeMetricsForWorkspace(workspaceId, workspaceId, [chainWithUnsummarised], [errorJob]);

            // Should be flagged (both conditions present)
            expect(metrics.hasAttentionItems).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Workspace does NOT have attention items when no unsummarised sessions and no queue errors.
     * Validates: Requirement 10.7
     */
    it('does NOT flag attention when workspace has no unsummarised sessions and no errors', () => {
      fc.assert(
        fc.property(
          validWorkspaceIdArb,
          fc.integer({ min: 0, max: 10 }),
          fc.integer({ min: 0, max: 10 }),
          (workspaceId, chainCount, jobCount) => {
            // Chains with NO unsummarised messages
            const chains = Array.from({ length: chainCount }, () => makeChain(workspaceId, 10, { unsummarisedDelta: 0 }));

            // Jobs with NO errors
            const jobs = Array.from({ length: jobCount }, () => makeJob(workspaceId, 'done'));

            const metrics = computeMetricsForWorkspace(workspaceId, workspaceId, chains, jobs);

            // Should NOT be flagged
            expect(metrics.hasAttentionItems).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Running jobs (not error) do NOT trigger attention items.
     * Validates: Requirement 10.7 (only errors, not running jobs)
     */
    it('does NOT flag attention for running jobs (only errors)', () => {
      fc.assert(
        fc.property(
          validWorkspaceIdArb,
          fc.integer({ min: 1, max: 10 }),
          (workspaceId, runningCount) => {
            const runningJobs = Array.from({ length: runningCount }, () => makeJob(workspaceId, 'running'));
            const metrics = computeMetricsForWorkspace(workspaceId, workspaceId, [], runningJobs);

            // Running jobs should NOT trigger attention
            expect(metrics.hasAttentionItems).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Attention item detection is independent across workspaces.
     * Validates: Requirement 10.7
     */
    it('detects attention items independently per workspace', () => {
      fc.assert(
        fc.property(
          fc.tuple(validWorkspaceIdArb, validWorkspaceIdArb).filter(([a, b]) => a !== b),
          fc.boolean(),
          fc.boolean(),
          ([workspaceA, workspaceB], aHasIssue, bHasIssue) => {
            const chainsA = aHasIssue ? [makeChain(workspaceA, 10, { unsummarisedDelta: 1 })] : [makeChain(workspaceA, 10, { unsummarisedDelta: 0 })];
            const chainsB = bHasIssue ? [makeChain(workspaceB, 10, { unsummarisedDelta: 1 })] : [makeChain(workspaceB, 10, { unsummarisedDelta: 0 })];

            const allChains = [...chainsA, ...chainsB];

            const metricsA = computeMetricsForWorkspace(workspaceA, workspaceA, allChains, []);
            const metricsB = computeMetricsForWorkspace(workspaceB, workspaceB, allChains, []);

            // Each workspace flagged independently
            expect(metricsA.hasAttentionItems).toBe(aHasIssue);
            expect(metricsB.hasAttentionItems).toBe(bHasIssue);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
