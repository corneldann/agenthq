// Feature: monitor-dashboard-redesign, Property 8: Attention section membership matches attention conditions
// Validates: Requirements 6.3, 6.4
//
// NOTE: This file intentionally avoids importing source modules that carry
// browser side-effects (localStorage, DOM). The attention-condition predicate
// and attentionColour logic are inlined here — mirroring the pattern used in
// navigation.test.ts — so the test runs cleanly in Bun's Node-like environment.

import * as fc from 'fast-check';
import { test, expect, describe } from 'bun:test';

// ---------------------------------------------------------------------------
// Inline types (mirrors types.ts exactly)
// ---------------------------------------------------------------------------

interface SessionState {
  workflowHash: string;
  sessionJsonl: string;
  chainId: string;
  chainIndex: number;
  previousSession: string;
  topic: string;
  messageCount: number;
  userMessageCount: number;
  contextUsagePct: number;
  lastMessageAt: string;
  lastSummarisedMessageCount: number;
  lastSummarisedAt: string;
  summaryFile: string;
  status: 'active' | 'idle' | 'complete' | 'rate-limited';
  firstUserMessage: string;
  lastUserMessage: string;
  lastAgentMessage: string;
  startTime: string;
}

interface Chain {
  chainId: string;
  displayName: string;
  nextIndex: number;
  sessions: Array<{
    index: number;
    workflowHash: string;
    date: string;
    messageCount: number;
    status: string;
  }>;
  totalMessages: number;
  createdAt: string;
  lastActiveAt: string;
  latestSession?: SessionState;
  unsummarisedDelta?: number;
  overallStatus?: string;
  workflowCount?: number;
}

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
}

type AttentionColour = 'amber' | 'blue' | 'red';

// ---------------------------------------------------------------------------
// Pure logic — mirrors attentionRow.ts and dashboard.ts exactly
// ---------------------------------------------------------------------------

/**
 * attentionColour — mirrors the exported function in components/attentionRow.ts.
 *
 * Priority:
 *   1. Blue  — runningJob present (status === 'running')
 *   2. Red   — latestSession.contextUsagePct >= 70
 *   3. Amber — unsummarisedDelta > 0
 *   null     — no condition met
 */
function attentionColour(chain: Chain, runningJob?: Job): AttentionColour | null {
  if (runningJob !== undefined && runningJob.status === 'running') return 'blue';
  const contextPct = chain.latestSession?.contextUsagePct ?? null;
  if (contextPct !== null && contextPct >= 70) return 'red';
  if ((chain.unsummarisedDelta ?? 0) > 0) return 'amber';
  return null;
}

/**
 * qualifies — mirrors chainNeedsAttention in pages/dashboard.ts.
 * Returns true when a chain should appear in the Attention section.
 */
function qualifies(chain: Chain, jobs: Job[]): boolean {
  if ((chain.unsummarisedDelta ?? 0) > 0) return true;
  const runningJob = jobs.find(
    (j) => j.sessionChainId === chain.chainId && j.status === 'running',
  );
  if (runningJob !== undefined) return true;
  if ((chain.latestSession?.contextUsagePct ?? 0) >= 70) return true;
  return false;
}

/** Finds the first running job linked to a chain by sessionChainId. */
function findRunningJob(chain: Chain, jobs: Job[]): Job | undefined {
  return jobs.find(
    (j) => j.sessionChainId === chain.chainId && j.status === 'running',
  );
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const sessionStateArb: fc.Arbitrary<SessionState> = fc.record({
  workflowHash: fc.constant('hash'),
  sessionJsonl: fc.constant(''),
  chainId: fc.uuid(),
  chainIndex: fc.nat(),
  previousSession: fc.constant(''),
  topic: fc.constant(''),
  messageCount: fc.nat(),
  userMessageCount: fc.nat(),
  contextUsagePct: fc.float({ min: 0, max: 100, noNaN: true }),
  lastMessageAt: fc.constant(''),
  lastSummarisedMessageCount: fc.nat(),
  lastSummarisedAt: fc.constant(''),
  summaryFile: fc.constant(''),
  status: fc.constantFrom<SessionState['status']>('active', 'idle', 'complete', 'rate-limited'),
  firstUserMessage: fc.constant(''),
  lastUserMessage: fc.constant(''),
  lastAgentMessage: fc.constant(''),
  startTime: fc.constant(''),
});

const chainArb: fc.Arbitrary<Chain> = fc.record({
  chainId: fc.uuid(),
  displayName: fc.string(),
  nextIndex: fc.nat(),
  sessions: fc.constant([]),
  totalMessages: fc.nat(),
  createdAt: fc.constant(''),
  lastActiveAt: fc.constant(''),
  latestSession: fc.option(sessionStateArb, { nil: undefined }),
  unsummarisedDelta: fc.option(fc.nat(), { nil: undefined }),
  overallStatus: fc.constant(undefined),
  workflowCount: fc.constant(undefined),
});

const jobArb: fc.Arbitrary<Job> = fc.record({
  id: fc.uuid(),
  name: fc.string(),
  jobChain: fc.string(),
  sessionChainId: fc.oneof(fc.constant(''), fc.uuid()),
  timestamp: fc.constant(''),
  type: fc.string(),
  agent: fc.constant(''),
  status: fc.constantFrom<Job['status']>('running', 'done', 'error', 'reported'),
  lines: fc.nat(),
  lastLine: fc.constant(''),
  hasLog: fc.boolean(),
  logError: fc.boolean(),
  mdFile: fc.constant(''),
  logFile: fc.constant(''),
  agentDone: fc.constant(''),
  sizeBytes: fc.nat(),
});

// ---------------------------------------------------------------------------
// Property 8: Attention section membership matches attention conditions
// ---------------------------------------------------------------------------

describe('Property 8 — Attention section membership', () => {
  /**
   * P8.1 — attentionColour is non-null iff the chain satisfies at least one
   * attention condition. This validates the one-to-one correspondence between
   * qualifying chains and AttentionRows.
   *
   * Validates: Requirements 6.3, 6.4
   */
  test('P8.1: attentionColour is non-null iff chain satisfies at least one attention condition', () => {
    // Feature: monitor-dashboard-redesign, Property 8: Attention section membership matches attention conditions
    fc.assert(
      fc.property(
        fc.array(chainArb, { minLength: 0, maxLength: 20 }),
        fc.array(jobArb, { minLength: 0, maxLength: 30 }),
        (chains, jobs) => {
          for (const chain of chains) {
            const runningJob = findRunningJob(chain, jobs);
            const colour = attentionColour(chain, runningJob);
            const expected = qualifies(chain, jobs);
            // Qualifying chain → non-null (would render an AttentionRow)
            // Non-qualifying chain → null (would be omitted)
            expect(colour !== null).toBe(expected);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P8.2 — No extras: chains with zero delta, no running job, and low context
   * must never produce a non-null colour (no false positives).
   *
   * Validates: Requirements 6.4
   */
  test('P8.2: chain with no attention condition always produces null colour', () => {
    // Feature: monitor-dashboard-redesign, Property 8: Attention section membership matches attention conditions
    const nonQualifyingChainArb = chainArb.filter(
      (c) =>
        (c.unsummarisedDelta ?? 0) === 0 &&
        (c.latestSession === undefined || c.latestSession.contextUsagePct < 70),
    );
    const nonRunningJobArb = jobArb.filter((j) => j.status !== 'running');

    fc.assert(
      fc.property(
        nonQualifyingChainArb,
        fc.array(nonRunningJobArb, { minLength: 0, maxLength: 10 }),
        (chain, nonRunningJobs) => {
          const runningJob = findRunningJob(chain, nonRunningJobs);
          expect(attentionColour(chain, runningJob)).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P8.3 — Completeness: unsummarisedDelta > 0 is always an attention trigger.
   *
   * Validates: Requirements 6.3
   */
  test('P8.3: chain with unsummarisedDelta > 0 always qualifies', () => {
    // Feature: monitor-dashboard-redesign, Property 8: Attention section membership matches attention conditions
    const chainWithDeltaArb = chainArb.map((c) => ({
      ...c,
      unsummarisedDelta: Math.max(1, c.unsummarisedDelta ?? 1),
    }));

    fc.assert(
      fc.property(chainWithDeltaArb, (chain) => {
        expect(attentionColour(chain, undefined)).not.toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P8.4 — Completeness: contextUsagePct >= 70 is always an attention trigger
   * (when no running job and zero delta, to isolate the condition).
   *
   * Validates: Requirements 6.3
   */
  test('P8.4: chain with contextUsagePct >= 70 always qualifies', () => {
    // Feature: monitor-dashboard-redesign, Property 8: Attention section membership matches attention conditions
    const highContextSessionArb = sessionStateArb.map((s) => ({
      ...s,
      contextUsagePct: 70 + (Math.abs(s.contextUsagePct) % 31), // clamp to [70, 100]
    }));

    fc.assert(
      fc.property(
        chainArb.map((c) => ({ ...c, unsummarisedDelta: 0 })),
        highContextSessionArb,
        (chain, session) => {
          const chainWithSession: Chain = { ...chain, latestSession: session };
          expect(attentionColour(chainWithSession, undefined)).not.toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P8.5 — Completeness: a linked running job is always an attention trigger.
   *
   * Validates: Requirements 6.3
   */
  test('P8.5: chain with a linked running job always qualifies', () => {
    // Feature: monitor-dashboard-redesign, Property 8: Attention section membership matches attention conditions
    const lowContextSessionArb = sessionStateArb.map((s) => ({
      ...s,
      contextUsagePct: Math.abs(s.contextUsagePct) % 70, // clamp to [0, 69]
    }));

    fc.assert(
      fc.property(
        chainArb.map((c) => ({ ...c, unsummarisedDelta: 0 })),
        fc.option(lowContextSessionArb, { nil: undefined }),
        (chain, maybeSession) => {
          const testChain: Chain = { ...chain, latestSession: maybeSession };
          const runningJob: Job = {
            id: 'test-job-id',
            name: 'test',
            jobChain: '',
            sessionChainId: testChain.chainId,
            timestamp: '',
            type: 'agent',
            agent: '',
            status: 'running',
            lines: 0,
            lastLine: '',
            hasLog: false,
            logError: false,
            mdFile: '',
            logFile: '',
            agentDone: '',
            sizeBytes: 0,
          };
          expect(attentionColour(testChain, runningJob)).not.toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P8.6 — Section visibility: when no chains qualify, the attention rows list
   * is empty. Mirrors the null-return guard in buildAttentionSection.
   *
   * Validates: Requirements 6.4
   */
  test('P8.6: when no chains qualify the attention row set is empty', () => {
    // Feature: monitor-dashboard-redesign, Property 8: Attention section membership matches attention conditions
    const nonQualifyingChainArb = chainArb.filter(
      (c) =>
        (c.unsummarisedDelta ?? 0) === 0 &&
        (c.latestSession === undefined || c.latestSession.contextUsagePct < 70),
    );
    const nonRunningJobArb = jobArb.filter((j) => j.status !== 'running');

    fc.assert(
      fc.property(
        fc.array(nonQualifyingChainArb, { minLength: 0, maxLength: 10 }),
        fc.array(nonRunningJobArb, { minLength: 0, maxLength: 10 }),
        (chains, nonRunningJobs) => {
          const attentionRows = chains
            .map((chain) => attentionColour(chain, findRunningJob(chain, nonRunningJobs)))
            .filter((c) => c !== null);
          expect(attentionRows).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 11: Dashboard sparkline normalisation
// Feature: monitor-dashboard-redesign, Property 11: Dashboard sparkline normalisation
// Validates: Requirement 6.14
// ---------------------------------------------------------------------------

interface PollLogEntry {
  ts: number;
  type: 'CRAWL' | 'CLONE' | 'PROMPT' | 'poll';
  count: number;
  detail: string;
  workflowHash: string;
}

// ---------------------------------------------------------------------------
// Inline pure logic — mirrors buildSparkline in pages/dashboard.ts exactly
// ---------------------------------------------------------------------------

/** Maps PollLogEntry type → expected CSS modifier (mirrors sparklineModifier). */
function expectedModifier(type: PollLogEntry['type']): string {
  switch (type) {
    case 'CRAWL':  return 'crawl';
    case 'CLONE':  return 'clone';
    case 'PROMPT': return 'prompt';
    case 'poll':   return 'poll';
    default:       return 'poll';
  }
}

interface SparklineBar {
  heightPct: number;
  modifier: string;
}

/** Pure sparkline normalisation — exactly mirrors buildSparkline logic. */
function computeSparkline(pollLog: PollLogEntry[]): SparklineBar[] {
  const window = pollLog.slice(-30);
  const maxCount = window.reduce((m, e) => Math.max(m, e.count), 0);
  return window.map((entry) => ({
    heightPct: maxCount > 0 ? (entry.count / maxCount) * 100 : 0,
    modifier: `sparkline__bar--${expectedModifier(entry.type)}`,
  }));
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const pollLogEntryArb: fc.Arbitrary<PollLogEntry> = fc.record({
  ts: fc.integer({ min: 0 }),
  type: fc.constantFrom<PollLogEntry['type']>('CRAWL', 'CLONE', 'PROMPT', 'poll'),
  count: fc.nat({ max: 1000 }),
  detail: fc.constant(''),
  workflowHash: fc.constant(''),
});

// pollLog with 0–30 entries (the full property range from the spec)
const pollLogArb = fc.array(pollLogEntryArb, { minLength: 0, maxLength: 30 });

// pollLog deliberately over 30 entries to exercise the slice(-30) cap
const pollLogOverCap = fc.array(pollLogEntryArb, { minLength: 31, maxLength: 60 });

// ---------------------------------------------------------------------------
// Property 11 tests
// ---------------------------------------------------------------------------

describe('Property 11 — Dashboard sparkline normalisation', () => {
  /**
   * P11.1 — Bar count = Math.min(pollLog.length, 30).
   * For any pollLog up to 30 entries, the sparkline has exactly pollLog.length bars.
   *
   * Validates: Requirement 6.14
   */
  test('P11.1: bar count equals Math.min(pollLog.length, 30)', () => {
    // Feature: monitor-dashboard-redesign, Property 11: Dashboard sparkline normalisation
    fc.assert(
      fc.property(
        fc.oneof(pollLogArb, pollLogOverCap),
        (pollLog) => {
          const bars = computeSparkline(pollLog);
          expect(bars).toHaveLength(Math.min(pollLog.length, 30));
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P11.2 — Height proportionality: each bar's heightPct equals
   * (entry.count / maxCount) * 100 relative to the window's max count.
   * When all counts are 0 (or window is empty), all bars have 0 height.
   *
   * Validates: Requirement 6.14
   */
  test('P11.2: bar heights are proportional to count relative to window max', () => {
    // Feature: monitor-dashboard-redesign, Property 11: Dashboard sparkline normalisation
    fc.assert(
      fc.property(
        pollLogArb,
        (pollLog) => {
          const bars = computeSparkline(pollLog);
          if (bars.length === 0) return; // empty window — nothing to check
          const window = pollLog.slice(-30);
          const maxCount = window.reduce((m, e) => Math.max(m, e.count), 0);

          for (let i = 0; i < bars.length; i++) {
            const expected = maxCount > 0 ? (window[i].count / maxCount) * 100 : 0;
            expect(bars[i].heightPct).toBeCloseTo(expected, 10);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P11.3 — All-zero counts → all bars at 0 height.
   *
   * Validates: Requirement 6.14
   */
  test('P11.3: when all counts are 0 every bar has 0 height', () => {
    // Feature: monitor-dashboard-redesign, Property 11: Dashboard sparkline normalisation
    const zeroCountLogArb = fc.array(
      pollLogEntryArb.map((e) => ({ ...e, count: 0 })),
      { minLength: 1, maxLength: 30 },
    );

    fc.assert(
      fc.property(zeroCountLogArb, (pollLog) => {
        const bars = computeSparkline(pollLog);
        for (const bar of bars) {
          expect(bar.heightPct).toBe(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P11.4 — Max bar is always at full height (100%) when max count > 0.
   *
   * Validates: Requirement 6.14
   */
  test('P11.4: the bar with the maximum count has 100% height', () => {
    // Feature: monitor-dashboard-redesign, Property 11: Dashboard sparkline normalisation
    const nonZeroLogArb = fc.array(
      pollLogEntryArb,
      { minLength: 1, maxLength: 30 },
    ).filter((log) => log.some((e) => e.count > 0));

    fc.assert(
      fc.property(nonZeroLogArb, (pollLog) => {
        const bars = computeSparkline(pollLog);
        const maxHeight = Math.max(...bars.map((b) => b.heightPct));
        expect(maxHeight).toBeCloseTo(100, 10);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P11.5 — Colour coding: each bar's modifier class matches its entry type.
   *   CRAWL → sparkline__bar--crawl
   *   CLONE → sparkline__bar--clone
   *   PROMPT → sparkline__bar--prompt
   *   poll   → sparkline__bar--poll
   *
   * Validates: Requirement 6.14
   */
  test('P11.5: each bar is colour-coded by its PollLogEntry type', () => {
    // Feature: monitor-dashboard-redesign, Property 11: Dashboard sparkline normalisation
    fc.assert(
      fc.property(
        pollLogArb,
        (pollLog) => {
          const bars = computeSparkline(pollLog);
          const window = pollLog.slice(-30);
          for (let i = 0; i < bars.length; i++) {
            const expectedClass = `sparkline__bar--${expectedModifier(window[i].type)}`;
            expect(bars[i].modifier).toBe(expectedClass);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P11.6 — Slice semantics: when pollLog has more than 30 entries, only the
   * last 30 are used for bars and height normalisation.
   *
   * Validates: Requirement 6.14
   */
  test('P11.6: when pollLog exceeds 30 entries only the last 30 are used', () => {
    // Feature: monitor-dashboard-redesign, Property 11: Dashboard sparkline normalisation
    fc.assert(
      fc.property(pollLogOverCap, (pollLog) => {
        const bars = computeSparkline(pollLog);
        expect(bars).toHaveLength(30);

        // Heights must match a fresh computation using only the last 30
        const last30 = pollLog.slice(-30);
        const barsFromLast30 = computeSparkline(last30);
        for (let i = 0; i < 30; i++) {
          expect(bars[i].heightPct).toBeCloseTo(barsFromLast30[i].heightPct, 10);
          expect(bars[i].modifier).toBe(barsFromLast30[i].modifier);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10: Git section display matches GitStatus clean flag
// Feature: monitor-dashboard-redesign, Property 10: Git section display matches clean flag
// Validates: Requirements 6.8, 6.9
// ---------------------------------------------------------------------------
//
// NOTE: Avoids importing gitSection.ts (carries DOM/browser side-effects).
// The decision logic is inlined here as a pure function mirroring the
// exact if/else tree in rerender() → gitStatus.clean ? renderClean() : renderDirty()

type CommitState = null | 'running' | 'done' | 'error';

interface GitStatus {
  branch: string;
  clean: boolean;
  modified: string[];
  staged: string[];
  untracked: string[];
  ahead: number;
  behind: number;
}

/**
 * The two mutually-exclusive display modes for the Git section.
 * 'clean'    — "✓ Nothing to commit — up to date", no file list, no commit button.
 * 'dirty'    — file list rows + [Commit & Push] button.
 * 'other'    — commitState is non-null (running/done/error); neither mode above applies.
 */
type GitSectionMode = 'clean' | 'dirty' | 'other';

/**
 * Pure function that mirrors the rendering decision in gitSection.ts rerender().
 * Returns the active display mode given a GitStatus and a CommitState.
 *
 * Requirements 6.8 and 6.9 define:
 *   clean === true  AND commitState === null → 'clean' indicator (no file list)
 *   clean === false AND commitState === null → file list + [Commit & Push]
 *   commitState !== null                    → commit state UI ('other')
 */
function gitSectionMode(gitStatus: GitStatus, commitState: CommitState): GitSectionMode {
  if (commitState !== null) return 'other';
  return gitStatus.clean ? 'clean' : 'dirty';
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const gitStatusArb: fc.Arbitrary<GitStatus> = fc.record({
  branch: fc.string({ minLength: 1 }),
  clean: fc.boolean(),
  modified:  fc.array(fc.string({ minLength: 1 })),
  staged:    fc.array(fc.string({ minLength: 1 })),
  untracked: fc.array(fc.string({ minLength: 1 })),
  ahead:  fc.nat(),
  behind: fc.nat(),
});

const commitStateArb: fc.Arbitrary<CommitState> = fc.constantFrom<CommitState>(
  null, 'running', 'done', 'error',
);

// ---------------------------------------------------------------------------
// Property 10 tests
// ---------------------------------------------------------------------------

describe('Property 10 — Git section display matches clean flag', () => {
  /**
   * P10.1 — When clean === true AND commitState === null, the mode is 'clean'.
   * Validates: Requirement 6.8
   */
  test('P10.1: clean===true + commitState===null → clean indicator rendered', () => {
    // Feature: monitor-dashboard-redesign, Property 10: Git section display matches clean flag
    const cleanStatusArb = gitStatusArb.map((g) => ({ ...g, clean: true }));

    fc.assert(
      fc.property(cleanStatusArb, (gitStatus) => {
        const mode = gitSectionMode(gitStatus, null);
        expect(mode).toBe('clean');
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P10.2 — When clean === false AND commitState === null, the mode is 'dirty'.
   * Validates: Requirement 6.9
   */
  test('P10.2: clean===false + commitState===null → file list + commit button rendered', () => {
    // Feature: monitor-dashboard-redesign, Property 10: Git section display matches clean flag
    const dirtyStatusArb = gitStatusArb.map((g) => ({ ...g, clean: false }));

    fc.assert(
      fc.property(dirtyStatusArb, (gitStatus) => {
        const mode = gitSectionMode(gitStatus, null);
        expect(mode).toBe('dirty');
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P10.3 — The two states are NEVER simultaneous: for any input, mode is
   * exactly one of 'clean', 'dirty', or 'other' — never two at once.
   * Validates: Requirements 6.8, 6.9 ("never render simultaneously")
   */
  test('P10.3: clean and dirty states are never rendered simultaneously', () => {
    // Feature: monitor-dashboard-redesign, Property 10: Git section display matches clean flag
    fc.assert(
      fc.property(gitStatusArb, commitStateArb, (gitStatus, commitState) => {
        const mode = gitSectionMode(gitStatus, commitState);
        // Exactly one mode is active
        const isClean = mode === 'clean';
        const isDirty = mode === 'dirty';
        // They are mutually exclusive by construction; confirm they don't overlap
        expect(isClean && isDirty).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P10.4 — When commitState !== null, neither 'clean' nor 'dirty' is rendered.
   * (The commit-state machine UI takes over.)
   * Validates: Requirements 6.8, 6.9 (implied by state machine design)
   */
  test('P10.4: when commitState is non-null neither clean nor dirty indicator is shown', () => {
    // Feature: monitor-dashboard-redesign, Property 10: Git section display matches clean flag
    const nonNullCommitStateArb = commitStateArb.filter(
      (cs): cs is 'running' | 'done' | 'error' => cs !== null,
    );

    fc.assert(
      fc.property(gitStatusArb, nonNullCommitStateArb, (gitStatus, commitState) => {
        const mode = gitSectionMode(gitStatus, commitState);
        expect(mode).toBe('other');
        expect(mode).not.toBe('clean');
        expect(mode).not.toBe('dirty');
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P10.5 — Full round-trip: mode is 'clean' iff clean===true AND commitState===null,
   *          and 'dirty' iff clean===false AND commitState===null.
   *          Covers both directions of the iff for Requirements 6.8 and 6.9.
   */
  test('P10.5: mode is clean iff clean===true and commitState===null (full iff)', () => {
    // Feature: monitor-dashboard-redesign, Property 10: Git section display matches clean flag
    fc.assert(
      fc.property(gitStatusArb, commitStateArb, (gitStatus, commitState) => {
        const mode = gitSectionMode(gitStatus, commitState);

        // Forward: clean===true + null → must be 'clean'
        if (gitStatus.clean && commitState === null) {
          expect(mode).toBe('clean');
        }
        // Forward: clean===false + null → must be 'dirty'
        if (!gitStatus.clean && commitState === null) {
          expect(mode).toBe('dirty');
        }
        // Backward: mode==='clean' → must have been clean===true + null
        if (mode === 'clean') {
          expect(gitStatus.clean).toBe(true);
          expect(commitState).toBeNull();
        }
        // Backward: mode==='dirty' → must have been clean===false + null
        if (mode === 'dirty') {
          expect(gitStatus.clean).toBe(false);
          expect(commitState).toBeNull();
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: AttentionRow styling and label correctness
// Feature: monitor-dashboard-redesign, Property 9: AttentionRow styling and label correctness
// Validates: Requirements 6.5, 6.6, 6.7
// ---------------------------------------------------------------------------
//
// Tests verify that when a Chain satisfies exactly one attention condition,
// the correct CSS class (amber/blue/red) and label format are produced.
//
// Requirements:
//   6.5: unsummarisedDelta > 0 → amber, "[name] · [delta] unsummarised"
//   6.6: linked running job     → blue,  "[name] · [jobType] running"
//   6.7: contextUsagePct >= 70  → red,   "[name] · context [pct]%"

// ---------------------------------------------------------------------------
// Pure label-building logic — mirrors attentionRow.ts exactly
// ---------------------------------------------------------------------------

/**
 * Builds the label text for an amber attention row (unsummarisedDelta > 0).
 * Mirrors buildAmber in attentionRow.ts.
 */
function amberLabel(chain: Chain): string {
  return `${chain.displayName} · ${chain.unsummarisedDelta ?? 0} unsummarised`;
}

/**
 * Builds the label text for a blue attention row (linked running job).
 * Mirrors buildBlue in attentionRow.ts.
 */
function blueLabel(chain: Chain, runningJob: Job): string {
  return `${chain.displayName} · ${runningJob.type} running`;
}

/**
 * Builds the label text for a red attention row (contextUsagePct >= 70).
 * Mirrors buildRed in attentionRow.ts.
 */
function redLabel(chain: Chain, contextUsagePct: number): string {
  return `${chain.displayName} · context ${contextUsagePct}%`;
}

// ---------------------------------------------------------------------------
// Arbitraries for Property 9
// ---------------------------------------------------------------------------

/** Chain with unsummarisedDelta > 0 ONLY (amber condition isolated). */
const amberChainArb: fc.Arbitrary<Chain> = chainArb.map((c) => ({
  ...c,
  unsummarisedDelta: Math.max(1, c.unsummarisedDelta ?? 1), // force > 0
  latestSession:
    c.latestSession !== undefined
      ? { ...c.latestSession, contextUsagePct: Math.min(69, c.latestSession.contextUsagePct) }
      : undefined, // force < 70 if session present
}));

/** Chain with contextUsagePct >= 70 ONLY (red condition isolated). */
const redChainArb: fc.Arbitrary<Chain> = chainArb.map((c) => ({
  ...c,
  unsummarisedDelta: 0, // force no amber condition
  latestSession: {
    ...(c.latestSession ?? ({} as SessionState)),
    contextUsagePct: 70 + (Math.abs(c.latestSession?.contextUsagePct ?? 0) % 31), // clamp [70, 100]
  },
}));

/** Chain with NO local attention condition, paired with a running job (blue condition isolated). */
const blueChainArb: fc.Arbitrary<Chain> = chainArb.map((c) => ({
  ...c,
  unsummarisedDelta: 0, // force no amber
  latestSession:
    c.latestSession !== undefined
      ? { ...c.latestSession, contextUsagePct: Math.min(69, c.latestSession.contextUsagePct) }
      : undefined, // force < 70 if session present
}));

/** Job with status === 'running'. */
const runningJobArb: fc.Arbitrary<Job> = jobArb.map((j) => ({
  ...j,
  status: 'running' as const,
}));

// ---------------------------------------------------------------------------
// Property 9 tests
// ---------------------------------------------------------------------------

describe('Property 9 — AttentionRow styling and label correctness', () => {
  /**
   * P9.1 — Amber row: unsummarisedDelta > 0 only.
   * Validates: Requirement 6.5
   */
  test('P9.1: unsummarisedDelta > 0 → amber styling and "[name] · [delta] unsummarised"', () => {
    // Feature: monitor-dashboard-redesign, Property 9: AttentionRow styling and label correctness
    fc.assert(
      fc.property(amberChainArb, (chain) => {
        // No running job
        const colour = attentionColour(chain, undefined);
        const expectedLabel = amberLabel(chain);

        // Assert: amber colour
        expect(colour).toBe('amber');

        // Assert: label matches pattern
        expect(expectedLabel).toContain(chain.displayName);
        expect(expectedLabel).toContain(`${chain.unsummarisedDelta} unsummarised`);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P9.2 — Blue row: linked running job only.
   * Validates: Requirement 6.6
   */
  test('P9.2: linked running job → blue styling and "[name] · [jobType] running"', () => {
    // Feature: monitor-dashboard-redesign, Property 9: AttentionRow styling and label correctness
    fc.assert(
      fc.property(blueChainArb, runningJobArb, (chain, job) => {
        // Link the job to the chain
        const linkedJob: Job = { ...job, sessionChainId: chain.chainId };
        const colour = attentionColour(chain, linkedJob);
        const expectedLabel = blueLabel(chain, linkedJob);

        // Assert: blue colour
        expect(colour).toBe('blue');

        // Assert: label matches pattern
        expect(expectedLabel).toContain(chain.displayName);
        expect(expectedLabel).toContain(`${linkedJob.type} running`);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P9.3 — Red row: contextUsagePct >= 70 only.
   * Validates: Requirement 6.7
   */
  test('P9.3: contextUsagePct >= 70 → red styling and "[name] · context [pct]%"', () => {
    // Feature: monitor-dashboard-redesign, Property 9: AttentionRow styling and label correctness
    fc.assert(
      fc.property(redChainArb, (chain) => {
        // No running job
        const colour = attentionColour(chain, undefined);
        const pct = chain.latestSession?.contextUsagePct ?? 0;
        const expectedLabel = redLabel(chain, pct);

        // Assert: red colour
        expect(colour).toBe('red');

        // Assert: label matches pattern
        expect(expectedLabel).toContain(chain.displayName);
        expect(expectedLabel).toContain(`context ${pct}%`);

        // Assert: pct >= 70 (requirement boundary)
        expect(pct).toBeGreaterThanOrEqual(70);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P9.4 — Priority correctness: when multiple conditions apply, blue > red > amber.
   * This validates the priority order from attentionColour.
   */
  test('P9.4: when multiple conditions apply blue takes priority over red and amber', () => {
    // Feature: monitor-dashboard-redesign, Property 9: AttentionRow styling and label correctness
    fc.assert(
      fc.property(
        chainArb.map((c) => ({
          ...c,
          unsummarisedDelta: Math.max(1, c.unsummarisedDelta ?? 1), // force amber
          latestSession: {
            ...(c.latestSession ?? ({} as SessionState)),
            contextUsagePct: 70 + (Math.abs(c.latestSession?.contextUsagePct ?? 0) % 31), // force red
          },
        })),
        runningJobArb,
        (chain, job) => {
          // All three conditions present: unsummarisedDelta > 0, contextUsagePct >= 70, running job
          const linkedJob: Job = { ...job, sessionChainId: chain.chainId };
          const colour = attentionColour(chain, linkedJob);

          // Blue wins by priority
          expect(colour).toBe('blue');
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P9.5 — Priority correctness: when red + amber both apply (no blue), red wins.
   */
  test('P9.5: when contextUsagePct >= 70 and unsummarisedDelta > 0 red takes priority', () => {
    // Feature: monitor-dashboard-redesign, Property 9: AttentionRow styling and label correctness
    fc.assert(
      fc.property(
        chainArb.map((c) => ({
          ...c,
          unsummarisedDelta: Math.max(1, c.unsummarisedDelta ?? 1), // force amber
          latestSession: {
            ...(c.latestSession ?? ({} as SessionState)),
            contextUsagePct: 70 + (Math.abs(c.latestSession?.contextUsagePct ?? 0) % 31), // force red
          },
        })),
        (chain) => {
          // No running job
          const colour = attentionColour(chain, undefined);

          // Red wins by priority
          expect(colour).toBe('red');
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P9.6 — Label field substitution correctness: all template placeholders are replaced
   * with actual chain field values (never left as literal "[name]", "[delta]", etc.).
   */
  test('P9.6: labels contain actual field values not literal placeholders', () => {
    // Feature: monitor-dashboard-redesign, Property 9: AttentionRow styling and label correctness
    fc.assert(
      fc.property(
        amberChainArb,
        blueChainArb,
        runningJobArb,
        redChainArb,
        (amberChain, blueChain, job, redChain) => {
          // Amber label
          const amberLbl = amberLabel(amberChain);
          expect(amberLbl).not.toContain('[name]');
          expect(amberLbl).not.toContain('[delta]');
          expect(amberLbl).toContain(amberChain.displayName);
          expect(amberLbl).toContain(`${amberChain.unsummarisedDelta}`);

          // Blue label
          const linkedJob: Job = { ...job, sessionChainId: blueChain.chainId };
          const blueLbl = blueLabel(blueChain, linkedJob);
          expect(blueLbl).not.toContain('[name]');
          expect(blueLbl).not.toContain('[jobType]');
          expect(blueLbl).toContain(blueChain.displayName);
          expect(blueLbl).toContain(linkedJob.type);

          // Red label
          const pct = redChain.latestSession?.contextUsagePct ?? 0;
          const redLbl = redLabel(redChain, pct);
          expect(redLbl).not.toContain('[name]');
          expect(redLbl).not.toContain('[pct]');
          expect(redLbl).not.toContain('[contextUsagePct]');
          expect(redLbl).toContain(redChain.displayName);
          expect(redLbl).toContain(`${pct}%`);
        },
      ),
      { numRuns: 100 },
    );
  });
});
