// Feature: monitor-dashboard-redesign, Property 17: Activity dispatch log descending timestamp order
// Validates: Requirement 8.3
// Also validates: Requirements 6.6, 6.7 (workspace filtering of sessions)

/**
 * This test file tests the dispatch log sort+slice logic and session workspace
 * filtering logic for the Activity page.
 *
 * Because activity.ts transitively imports state.ts (which calls localStorage at
 * module-evaluation time) and utils.ts (which references document), the pure
 * sort+slice and filter functions are mirrored here to keep the tests hermetic and
 * dependency-free — identical to the pattern used in work.test.ts and
 * dashboard.test.ts.
 *
 * The mirrored logic is deliberately identical to the relevant functions in
 * pages/activity.ts. Any divergence in activity.ts should be reflected here.
 */

import { describe, test, expect } from 'bun:test';
import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// Minimal type alias (matches types.ts exactly — no runtime dependency)
// ---------------------------------------------------------------------------

interface PollLogEntry {
  ts: number;
  type: 'CRAWL' | 'CLONE' | 'PROMPT' | 'poll';
  count: number;
  detail: string;
  workflowHash: string;
}

// Minimal SessionState fields needed for filter tests
interface SessionState {
  workspaceId: string;
  lastMessageAt: string;
  status: 'active' | 'idle' | 'complete' | 'rate-limited';
  messageCount: number;
  contextUsagePct: number;
  topic: string;
  firstUserMessage: string;
}

// Minimal Chain fields needed for filter tests
interface Chain {
  chainId: string;
  workspaceId: string;
  displayName: string;
  latestSession?: SessionState;
}

// ---------------------------------------------------------------------------
// Mirrored pure logic — source-of-truth: pages/activity.ts buildDispatchTable
// ---------------------------------------------------------------------------

/**
 * getDispatchLogRows — returns the 200 most recent PollLogEntry records from
 * pollLog, sorted descending by ts (newest first).
 *
 * Mirrors the sort+slice expression inside buildDispatchTable:
 *   pollLog.slice().sort((a, b) => b.ts - a.ts).slice(0, 200)
 */
function getDispatchLogRows(pollLog: PollLogEntry[]): PollLogEntry[] {
  return pollLog.slice().sort((a, b) => b.ts - a.ts).slice(0, 200);
}

// ---------------------------------------------------------------------------
// Mirrored pure logic — source-of-truth: pages/activity.ts filterSessionsByWorkspace
// ---------------------------------------------------------------------------

/**
 * filterSessionsByWorkspace — mirrors the exported filterSessionsByWorkspace
 * function from pages/activity.ts.
 *
 * Requirement 6.6: when selectedWorkspaceId is a string, only sessions where
 *   chain.workspaceId === selectedWorkspaceId are included.
 * Requirement 6.7: when selectedWorkspaceId is null, all sessions are included.
 */
function filterSessionsByWorkspace(
  chains: Chain[],
  selectedWorkspaceId: string | null,
): Array<{ session: SessionState; chain: Chain }> {
  return chains
    .filter((c): c is Chain & { latestSession: SessionState } => c.latestSession !== undefined)
    .filter((c) =>
      selectedWorkspaceId === null || c.workspaceId === selectedWorkspaceId,
    )
    .map((c) => ({ session: c.latestSession!, chain: c }))
    .sort((a, b) => {
      const ta = a.session.lastMessageAt ? new Date(a.session.lastMessageAt).getTime() : 0;
      const tb = b.session.lastMessageAt ? new Date(b.session.lastMessageAt).getTime() : 0;
      return tb - ta;
    });
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const pollLogEntryArb: fc.Arbitrary<PollLogEntry> = fc.record({
  ts: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  type: fc.constantFrom<PollLogEntry['type']>('CRAWL', 'CLONE', 'PROMPT', 'poll'),
  count: fc.nat({ max: 1000 }),
  detail: fc.string(),
  workflowHash: fc.string(),
});

const workspaceIdArb: fc.Arbitrary<string> = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/);

const sessionStateArb = (workspaceId: string): fc.Arbitrary<SessionState> =>
  fc.record({
    workspaceId: fc.constant(workspaceId),
    lastMessageAt: fc.integer({ min: 0, max: 1_700_000_000_000 })
      .map((ts) => new Date(ts).toISOString()),
    status: fc.constantFrom<SessionState['status']>('active', 'idle', 'complete', 'rate-limited'),
    messageCount: fc.nat({ max: 500 }),
    contextUsagePct: fc.float({ min: 0, max: 100, noNaN: true }),
    topic: fc.string(),
    firstUserMessage: fc.string(),
  });

const chainArb = (workspaceId: string, withSession = true): fc.Arbitrary<Chain> =>
  fc.record({
    chainId: fc.uuid(),
    workspaceId: fc.constant(workspaceId),
    displayName: fc.string(),
    latestSession: withSession
      ? sessionStateArb(workspaceId)
      : fc.constantFrom<SessionState | undefined>(undefined),
  });

// ---------------------------------------------------------------------------
// Property 17: Activity dispatch log descending timestamp order
// Feature: monitor-dashboard-redesign, Property 17: Activity dispatch log descending timestamp order
// ---------------------------------------------------------------------------

describe('Property 17 — Activity dispatch log descending timestamp order', () => {

  // -------------------------------------------------------------------------
  // P17.1: result length is Math.min(input.length, 200)
  // -------------------------------------------------------------------------

  test('P17.1: result length equals Math.min(pollLog.length, 200)', () => {
    // Feature: monitor-dashboard-redesign, Property 17: Activity dispatch log descending timestamp order
    fc.assert(
      fc.property(
        fc.array(pollLogEntryArb),
        (pollLog) => {
          const rows = getDispatchLogRows(pollLog);
          expect(rows).toHaveLength(Math.min(pollLog.length, 200));
        },
      ),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // P17.2: rows are sorted descending by ts (each row's ts >= next row's ts)
  // -------------------------------------------------------------------------

  test('P17.2: rows are sorted descending by ts (each row ts >= next row ts)', () => {
    // Feature: monitor-dashboard-redesign, Property 17: Activity dispatch log descending timestamp order
    fc.assert(
      fc.property(
        fc.array(pollLogEntryArb),
        (pollLog) => {
          const rows = getDispatchLogRows(pollLog);
          for (let i = 0; i < rows.length - 1; i++) {
            expect(rows[i].ts).toBeGreaterThanOrEqual(rows[i + 1].ts);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // P17.3: for entries with unique timestamps, order is strictly descending
  // -------------------------------------------------------------------------

  test('P17.3: for uniquely-timestamped entries order is strictly descending', () => {
    // Feature: monitor-dashboard-redesign, Property 17: Activity dispatch log descending timestamp order
    // Build a pollLog whose entries all have distinct ts values by mapping index to ts
    const uniqueTsLogArb = fc.array(pollLogEntryArb, { minLength: 2, maxLength: 50 }).map(
      (entries) =>
        entries.map((e, i) => ({ ...e, ts: i * 1000 + 1 })),
    );

    fc.assert(
      fc.property(
        uniqueTsLogArb,
        (pollLog) => {
          const rows = getDispatchLogRows(pollLog);
          for (let i = 0; i < rows.length - 1; i++) {
            expect(rows[i].ts).toBeGreaterThan(rows[i + 1].ts);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // P17.4: result contains the top-200 highest-ts entries, not an arbitrary 200
  // -------------------------------------------------------------------------

  test('P17.4: result contains the 200 highest-ts entries from the input', () => {
    // Feature: monitor-dashboard-redesign, Property 17: Activity dispatch log descending timestamp order
    fc.assert(
      fc.property(
        fc.array(pollLogEntryArb, { minLength: 0, maxLength: 300 }),
        (pollLog) => {
          const rows = getDispatchLogRows(pollLog);
          const limit = Math.min(pollLog.length, 200);

          // Compute expected top-200 by sorting descending and taking first 200
          const expected = pollLog.slice().sort((a, b) => b.ts - a.ts).slice(0, limit);

          // Each expected entry must appear in rows at the same position
          expect(rows).toHaveLength(expected.length);
          for (let i = 0; i < expected.length; i++) {
            expect(rows[i]).toStrictEqual(expected[i]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // P17.5: empty pollLog produces an empty result
  // -------------------------------------------------------------------------

  test('P17.5: empty pollLog produces an empty result', () => {
    // Feature: monitor-dashboard-redesign, Property 17: Activity dispatch log descending timestamp order
    expect(getDispatchLogRows([])).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // P17.6: pollLog with exactly 200 entries returns all 200
  // -------------------------------------------------------------------------

  test('P17.6: pollLog with exactly 200 entries returns all 200, sorted descending', () => {
    // Feature: monitor-dashboard-redesign, Property 17: Activity dispatch log descending timestamp order
    fc.assert(
      fc.property(
        fc.array(pollLogEntryArb, { minLength: 200, maxLength: 200 }),
        (pollLog) => {
          const rows = getDispatchLogRows(pollLog);
          expect(rows).toHaveLength(200);
          for (let i = 0; i < rows.length - 1; i++) {
            expect(rows[i].ts).toBeGreaterThanOrEqual(rows[i + 1].ts);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // P17.7: pollLog with more than 200 entries returns exactly 200
  // -------------------------------------------------------------------------

  test('P17.7: pollLog with more than 200 entries returns exactly 200 (the most recent)', () => {
    // Feature: monitor-dashboard-redesign, Property 17: Activity dispatch log descending timestamp order
    fc.assert(
      fc.property(
        fc.array(pollLogEntryArb, { minLength: 201, maxLength: 400 }),
        (pollLog) => {
          const rows = getDispatchLogRows(pollLog);
          expect(rows).toHaveLength(200);

          // Verify that the minimum ts in the result is >= any ts not in the result
          const resultTsMin = Math.min(...rows.map((r) => r.ts));
          const excluded = pollLog.slice().sort((a, b) => b.ts - a.ts).slice(200);
          for (const entry of excluded) {
            expect(resultTsMin).toBeGreaterThanOrEqual(entry.ts);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // P17.8: input array is not mutated (sort is performed on a copy)
  // -------------------------------------------------------------------------

  test('P17.8: getDispatchLogRows does not mutate the input array', () => {
    // Feature: monitor-dashboard-redesign, Property 17: Activity dispatch log descending timestamp order
    fc.assert(
      fc.property(
        fc.array(pollLogEntryArb, { minLength: 1, maxLength: 50 }),
        (pollLog) => {
          const originalOrder = pollLog.map((e) => e.ts);
          getDispatchLogRows(pollLog);
          const afterOrder = pollLog.map((e) => e.ts);
          expect(afterOrder).toStrictEqual(originalOrder);
        },
      ),
      { numRuns: 100 },
    );
  });

});

// ---------------------------------------------------------------------------
// Property 18 (partial): Dashboard Filtering Logic Consistency — sessions
// Feature: multi-workspace-monitoring, Requirements 6.6, 6.7
// ---------------------------------------------------------------------------

describe('filterSessionsByWorkspace — workspace filtering (Requirements 6.6, 6.7)', () => {

  // -------------------------------------------------------------------------
  // Unit: "All Workspaces" (null) — all chains with sessions are included
  // -------------------------------------------------------------------------

  test('null selectedWorkspaceId includes all chains that have a latestSession', () => {
    const wsA = 'workspace-a';
    const wsB = 'workspace-b';
    const chains: Chain[] = [
      { chainId: '1', workspaceId: wsA, displayName: 'A1', latestSession: {
        workspaceId: wsA, lastMessageAt: '2024-01-02T00:00:00.000Z',
        status: 'active', messageCount: 5, contextUsagePct: 30, topic: 'T1', firstUserMessage: 'M1',
      }},
      { chainId: '2', workspaceId: wsB, displayName: 'B1', latestSession: {
        workspaceId: wsB, lastMessageAt: '2024-01-01T00:00:00.000Z',
        status: 'idle', messageCount: 2, contextUsagePct: 10, topic: 'T2', firstUserMessage: 'M2',
      }},
      { chainId: '3', workspaceId: wsA, displayName: 'A2' /* no latestSession */ },
    ];

    const result = filterSessionsByWorkspace(chains, null);
    expect(result).toHaveLength(2);
    // Sorted descending by lastMessageAt
    expect(result[0].chain.chainId).toBe('1');
    expect(result[1].chain.chainId).toBe('2');
  });

  // -------------------------------------------------------------------------
  // Unit: specific workspace — only matching sessions included
  // -------------------------------------------------------------------------

  test('specific selectedWorkspaceId includes only sessions from that workspace', () => {
    const wsA = 'workspace-a';
    const wsB = 'workspace-b';
    const chains: Chain[] = [
      { chainId: '1', workspaceId: wsA, displayName: 'A1', latestSession: {
        workspaceId: wsA, lastMessageAt: '2024-01-02T00:00:00.000Z',
        status: 'active', messageCount: 5, contextUsagePct: 30, topic: 'T1', firstUserMessage: 'M1',
      }},
      { chainId: '2', workspaceId: wsB, displayName: 'B1', latestSession: {
        workspaceId: wsB, lastMessageAt: '2024-01-01T00:00:00.000Z',
        status: 'idle', messageCount: 2, contextUsagePct: 10, topic: 'T2', firstUserMessage: 'M2',
      }},
    ];

    const result = filterSessionsByWorkspace(chains, wsA);
    expect(result).toHaveLength(1);
    expect(result[0].chain.workspaceId).toBe(wsA);
  });

  // -------------------------------------------------------------------------
  // Unit: chains without latestSession are always excluded
  // -------------------------------------------------------------------------

  test('chains without latestSession are excluded regardless of workspace filter', () => {
    const chains: Chain[] = [
      { chainId: '1', workspaceId: 'ws-a', displayName: 'A' /* no latestSession */ },
      { chainId: '2', workspaceId: 'ws-b', displayName: 'B' /* no latestSession */ },
    ];

    expect(filterSessionsByWorkspace(chains, null)).toHaveLength(0);
    expect(filterSessionsByWorkspace(chains, 'ws-a')).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Unit: unknown workspace returns empty result
  // -------------------------------------------------------------------------

  test('selectedWorkspaceId with no matching chains returns empty array', () => {
    const chains: Chain[] = [
      { chainId: '1', workspaceId: 'ws-a', displayName: 'A', latestSession: {
        workspaceId: 'ws-a', lastMessageAt: '2024-01-01T00:00:00.000Z',
        status: 'active', messageCount: 3, contextUsagePct: 20, topic: 'T', firstUserMessage: 'M',
      }},
    ];

    const result = filterSessionsByWorkspace(chains, 'nonexistent-workspace');
    expect(result).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Property: filtering with null returns exactly the sessions with latestSession
  // -------------------------------------------------------------------------

  test('Property: null filter returns all sessions with latestSession (any workspace)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            chainArb('ws-a', true),
            chainArb('ws-b', true),
            chainArb('ws-a', false),
            chainArb('ws-b', false),
          ),
          { minLength: 0, maxLength: 30 },
        ),
        (chains) => {
          const result = filterSessionsByWorkspace(chains, null);
          const expectedCount = chains.filter((c) => c.latestSession !== undefined).length;
          expect(result).toHaveLength(expectedCount);
        },
      ),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // Property: filtering with a specific workspace ID returns only matching sessions
  // -------------------------------------------------------------------------

  test('Property: specific workspace filter returns only sessions from that workspace', () => {
    fc.assert(
      fc.property(
        workspaceIdArb,
        workspaceIdArb,
        fc.array(
          fc.oneof(
            chainArb('ws-a', true),
            chainArb('ws-b', true),
            chainArb('ws-a', false),
          ),
          { minLength: 0, maxLength: 20 },
        ),
        (wsA, wsB, _chains) => {
          // Build concrete chains with two known workspace IDs
          const chainsWithKnownWs: Chain[] = [
            { chainId: 'c1', workspaceId: wsA, displayName: 'C1', latestSession: {
              workspaceId: wsA, lastMessageAt: '2024-01-02T00:00:00.000Z',
              status: 'active', messageCount: 1, contextUsagePct: 10, topic: 'T', firstUserMessage: 'M',
            }},
            { chainId: 'c2', workspaceId: wsB, displayName: 'C2', latestSession: {
              workspaceId: wsB, lastMessageAt: '2024-01-01T00:00:00.000Z',
              status: 'idle', messageCount: 1, contextUsagePct: 5, topic: 'T2', firstUserMessage: 'M2',
            }},
            { chainId: 'c3', workspaceId: wsA, displayName: 'C3' /* no session */ },
          ];

          const resultA = filterSessionsByWorkspace(chainsWithKnownWs, wsA);
          const resultB = filterSessionsByWorkspace(chainsWithKnownWs, wsB);

          // All results must match the selected workspace
          expect(resultA.every((r) => r.chain.workspaceId === wsA)).toBe(true);
          expect(resultB.every((r) => r.chain.workspaceId === wsB)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // Property: result is sorted descending by lastMessageAt
  // -------------------------------------------------------------------------

  test('Property: result is sorted descending by lastMessageAt', () => {
    fc.assert(
      fc.property(
        fc.array(chainArb('ws-x', true), { minLength: 0, maxLength: 20 }),
        (chains) => {
          const result = filterSessionsByWorkspace(chains, null);
          for (let i = 0; i < result.length - 1; i++) {
            const ta = new Date(result[i].session.lastMessageAt).getTime();
            const tb = new Date(result[i + 1].session.lastMessageAt).getTime();
            expect(ta).toBeGreaterThanOrEqual(tb);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // Property: input array is not mutated
  // -------------------------------------------------------------------------

  test('Property: filterSessionsByWorkspace does not mutate the input array', () => {
    fc.assert(
      fc.property(
        fc.array(chainArb('ws-x', true), { minLength: 1, maxLength: 20 }),
        (chains) => {
          const originalIds = chains.map((c) => c.chainId);
          filterSessionsByWorkspace(chains, null);
          const afterIds = chains.map((c) => c.chainId);
          expect(afterIds).toStrictEqual(originalIds);
        },
      ),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // Property: case-sensitive matching — 'WS-A' !== 'ws-a'
  // -------------------------------------------------------------------------

  test('Property: workspace filter is case-sensitive', () => {
    const chains: Chain[] = [
      { chainId: '1', workspaceId: 'ws-a', displayName: 'A', latestSession: {
        workspaceId: 'ws-a', lastMessageAt: '2024-01-01T00:00:00.000Z',
        status: 'active', messageCount: 1, contextUsagePct: 5, topic: 'T', firstUserMessage: 'M',
      }},
    ];

    // 'WS-A' (uppercase) should NOT match 'ws-a' (lowercase)
    const result = filterSessionsByWorkspace(chains, 'WS-A');
    expect(result).toHaveLength(0);

    // exact match works
    const resultExact = filterSessionsByWorkspace(chains, 'ws-a');
    expect(resultExact).toHaveLength(1);
  });

});
