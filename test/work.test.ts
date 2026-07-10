// Feature: multi-workspace-monitoring
// Validates: Requirement 6.5
//
// Tests the workspace filtering logic for the Work page (pages/work.ts).
//
// Because work.ts transitively imports state.ts (which calls localStorage at
// module-evaluation time) and utils.ts (which references document), the pure
// filter logic is mirrored here to keep the tests hermetic and dependency-free
// — identical to the pattern used in activity.test.ts and dashboard.test.ts.
//
// The mirrored logic is deliberately identical to the relevant section of
// renderWork() in pages/work.ts. Any divergence in work.ts should be reflected here.

import { describe, test, expect } from 'bun:test';
import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// Minimal type aliases (match types.ts exactly — no runtime dependency)
// ---------------------------------------------------------------------------

interface Job {
  id: string;
  name: string;
  jobChain: string;
  sessionChainId: string;
  timestamp: string;
  type: string;
  agent: string;
  status: 'running' | 'done' | 'reported' | 'error';
  lines: number;
  lastLine: string;
  hasLog: boolean;
  logError: boolean;
  mdFile: string;
  logFile: string;
  agentDone: string;
  sizeBytes: number;
  workspaceId: string;
}

interface Chain {
  chainId: string;
  displayName: string;
  workspaceId: string;
  nextIndex: number;
  sessions: { index: number; workflowHash: string; date: string; messageCount: number; status: string }[];
  totalMessages: number;
  createdAt: string;
  lastActiveAt: string;
}

interface JobChain {
  jobChain: string;
  sessionChainId: string;
  type: string;
  latestStatus: string;
  latestTimestamp: string;
  runCount: number;
  runs: Job[];
  workspaceId: string;
}

// ---------------------------------------------------------------------------
// Mirrored pure logic — source-of-truth: pages/work.ts renderWork()
// ---------------------------------------------------------------------------

/**
 * filterByWorkspace — applies workspace filter to chains, jobChains, and jobs
 * exactly as renderWork() does.
 *
 * Requirement 6.5: WHEN a workspace is selected, only items matching that
 *   workspaceId are included.
 * Req 6.7 (null = "All Workspaces"): when selectedWorkspaceId is null, all
 *   items are returned.
 */
function filterByWorkspace(
  chains: Chain[],
  jobChains: JobChain[],
  jobs: Job[],
  selectedWorkspaceId: string | null,
): { chains: Chain[]; jobChains: JobChain[]; jobs: Job[] } {
  if (selectedWorkspaceId === null) {
    return { chains, jobChains, jobs };
  }
  return {
    chains:    chains.filter(c  => c.workspaceId  === selectedWorkspaceId),
    jobChains: jobChains.filter(jc => jc.workspaceId === selectedWorkspaceId),
    jobs:      jobs.filter(j   => j.workspaceId   === selectedWorkspaceId),
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeChain(id: string, workspaceId: string): Chain {
  return {
    chainId: id,
    displayName: `Chain ${id}`,
    workspaceId,
    nextIndex: 0,
    sessions: [],
    totalMessages: 0,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  };
}

function makeJobChain(name: string, workspaceId: string): JobChain {
  return {
    jobChain: name,
    sessionChainId: '',
    type: 'crawl',
    latestStatus: 'done',
    latestTimestamp: new Date().toISOString(),
    runCount: 1,
    runs: [],
    workspaceId,
  };
}

function makeJob(id: string, workspaceId: string): Job {
  return {
    id,
    name: `job-${id}`,
    jobChain: `job-${id}`,
    sessionChainId: '',
    timestamp: new Date().toISOString(),
    type: 'crawl',
    agent: 'agent',
    status: 'done',
    lines: 0,
    lastLine: '',
    hasLog: false,
    logError: false,
    mdFile: '',
    logFile: '',
    agentDone: '',
    sizeBytes: 0,
    workspaceId,
  };
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('Work page workspace filtering (Requirement 6.5)', () => {
  test('null selectedWorkspaceId returns all chains, jobChains, and jobs', () => {
    const chains    = [makeChain('c1', 'ws-a'), makeChain('c2', 'ws-b')];
    const jobChains = [makeJobChain('jc1', 'ws-a'), makeJobChain('jc2', 'ws-b')];
    const jobs      = [makeJob('j1', 'ws-a'), makeJob('j2', 'ws-b')];

    const result = filterByWorkspace(chains, jobChains, jobs, null);

    expect(result.chains).toHaveLength(2);
    expect(result.jobChains).toHaveLength(2);
    expect(result.jobs).toHaveLength(2);
  });

  test('specific workspace filters chains to matching workspaceId only', () => {
    const chains = [makeChain('c1', 'ws-a'), makeChain('c2', 'ws-b'), makeChain('c3', 'ws-a')];

    const result = filterByWorkspace(chains, [], [], 'ws-a');

    expect(result.chains).toHaveLength(2);
    expect(result.chains.every(c => c.workspaceId === 'ws-a')).toBe(true);
  });

  test('specific workspace filters jobChains to matching workspaceId only', () => {
    const jobChains = [makeJobChain('jc1', 'ws-a'), makeJobChain('jc2', 'ws-b')];

    const result = filterByWorkspace([], jobChains, [], 'ws-b');

    expect(result.jobChains).toHaveLength(1);
    expect(result.jobChains[0].workspaceId).toBe('ws-b');
  });

  test('specific workspace filters jobs to matching workspaceId only', () => {
    const jobs = [makeJob('j1', 'ws-a'), makeJob('j2', 'ws-b'), makeJob('j3', 'ws-a')];

    const result = filterByWorkspace([], [], jobs, 'ws-a');

    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.every(j => j.workspaceId === 'ws-a')).toBe(true);
  });

  test('workspace filter that matches no records returns empty arrays', () => {
    const chains    = [makeChain('c1', 'ws-a')];
    const jobChains = [makeJobChain('jc1', 'ws-a')];
    const jobs      = [makeJob('j1', 'ws-a')];

    const result = filterByWorkspace(chains, jobChains, jobs, 'ws-unknown');

    expect(result.chains).toHaveLength(0);
    expect(result.jobChains).toHaveLength(0);
    expect(result.jobs).toHaveLength(0);
  });

  test('filter is case-sensitive (ws-A does not match ws-a)', () => {
    const chains = [makeChain('c1', 'ws-a'), makeChain('c2', 'ws-A')];

    const result = filterByWorkspace(chains, [], [], 'ws-a');

    expect(result.chains).toHaveLength(1);
    expect(result.chains[0].chainId).toBe('c1');
  });

  test('empty input arrays with null filter returns empty arrays', () => {
    const result = filterByWorkspace([], [], [], null);

    expect(result.chains).toHaveLength(0);
    expect(result.jobChains).toHaveLength(0);
    expect(result.jobs).toHaveLength(0);
  });

  test('empty input arrays with a specific workspace returns empty arrays', () => {
    const result = filterByWorkspace([], [], [], 'ws-x');

    expect(result.chains).toHaveLength(0);
    expect(result.jobChains).toHaveLength(0);
    expect(result.jobs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Property-based tests — Validates: Requirement 6.5
// ---------------------------------------------------------------------------

describe('Work page workspace filtering — properties (Requirement 6.5)', () => {
  /**
   * Property: null filter returns all items (identity on all three collections).
   * Validates: Requirement 6.5 (null = "All Workspaces" shows everything)
   */
  test('Property: null filter returns all chains, jobChains, and jobs unchanged', () => {
    const workspaceIdArb = fc.string({ minLength: 1, maxLength: 20 });

    const chainArb = workspaceIdArb.map(wsId => makeChain(`c-${Math.random()}`, wsId));
    const jobChainArb = workspaceIdArb.map(wsId => makeJobChain(`jc-${Math.random()}`, wsId));
    const jobArb = workspaceIdArb.map(wsId => makeJob(`j-${Math.random()}`, wsId));

    fc.assert(
      fc.property(
        fc.array(chainArb),
        fc.array(jobChainArb),
        fc.array(jobArb),
        (chains, jobChains, jobs) => {
          const result = filterByWorkspace(chains, jobChains, jobs, null);
          expect(result.chains).toHaveLength(chains.length);
          expect(result.jobChains).toHaveLength(jobChains.length);
          expect(result.jobs).toHaveLength(jobs.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * Property: specific workspace filter returns only items matching that workspace.
   * Validates: Requirement 6.5 (when workspace is selected, only jobs for that workspace are shown)
   */
  test('Property: specific workspace filter returns only items with matching workspaceId', () => {
    const workspaceIdArb = fc.constantFrom('ws-alpha', 'ws-beta', 'ws-gamma');

    const chainArb = workspaceIdArb.map(wsId => makeChain(`c-${Math.random()}`, wsId));
    const jobChainArb = workspaceIdArb.map(wsId => makeJobChain(`jc-${Math.random()}`, wsId));
    const jobArb = workspaceIdArb.map(wsId => makeJob(`j-${Math.random()}`, wsId));

    fc.assert(
      fc.property(
        fc.array(chainArb),
        fc.array(jobChainArb),
        fc.array(jobArb),
        workspaceIdArb,
        (chains, jobChains, jobs, selectedId) => {
          const result = filterByWorkspace(chains, jobChains, jobs, selectedId);

          expect(result.chains.every(c  => c.workspaceId  === selectedId)).toBe(true);
          expect(result.jobChains.every(jc => jc.workspaceId === selectedId)).toBe(true);
          expect(result.jobs.every(j   => j.workspaceId   === selectedId)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * Property: filtered count never exceeds total count.
   * Validates: Requirement 6.5
   */
  test('Property: filtered count is always <= total count', () => {
    const workspaceIdArb = fc.constantFrom('ws-alpha', 'ws-beta', 'ws-gamma');

    const chainArb = workspaceIdArb.map(wsId => makeChain(`c-${Math.random()}`, wsId));
    const jobChainArb = workspaceIdArb.map(wsId => makeJobChain(`jc-${Math.random()}`, wsId));
    const jobArb = workspaceIdArb.map(wsId => makeJob(`j-${Math.random()}`, wsId));

    fc.assert(
      fc.property(
        fc.array(chainArb),
        fc.array(jobChainArb),
        fc.array(jobArb),
        workspaceIdArb,
        (chains, jobChains, jobs, selectedId) => {
          const result = filterByWorkspace(chains, jobChains, jobs, selectedId);

          expect(result.chains.length).toBeLessThanOrEqual(chains.length);
          expect(result.jobChains.length).toBeLessThanOrEqual(jobChains.length);
          expect(result.jobs.length).toBeLessThanOrEqual(jobs.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * Property: filter does not mutate the input arrays.
   * Validates: Requirement 6.5
   */
  test('Property: filterByWorkspace does not mutate input arrays', () => {
    const workspaceIdArb = fc.constantFrom('ws-alpha', 'ws-beta');

    const chainArb = workspaceIdArb.map(wsId => makeChain(`c-${Math.random()}`, wsId));
    const jobChainArb = workspaceIdArb.map(wsId => makeJobChain(`jc-${Math.random()}`, wsId));
    const jobArb = workspaceIdArb.map(wsId => makeJob(`j-${Math.random()}`, wsId));

    fc.assert(
      fc.property(
        fc.array(chainArb),
        fc.array(jobChainArb),
        fc.array(jobArb),
        fc.constantFrom('ws-alpha', 'ws-beta', null as string | null),
        (chains, jobChains, jobs, selectedId) => {
          const origChainsLen    = chains.length;
          const origJobChainsLen = jobChains.length;
          const origJobsLen      = jobs.length;

          filterByWorkspace(chains, jobChains, jobs, selectedId);

          expect(chains.length).toBe(origChainsLen);
          expect(jobChains.length).toBe(origJobChainsLen);
          expect(jobs.length).toBe(origJobsLen);
        },
      ),
      { numRuns: 200 },
    );
  });
});
