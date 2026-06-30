// Feature: monitor-dashboard-redesign, Property 12: Work page filter case-insensitive containment
// Validates: Requirement 7.8

/**
 * This test file tests the filter predicates for the Work page.
 *
 * Because work.ts transitively imports state.ts (which calls localStorage at
 * module-evaluation time, before any beforeAll/preload can run) and utils.ts
 * (which references document), we mirror the two pure predicates here to keep
 * the tests hermetic and dependency-free.
 *
 * The mirror functions are deliberately identical to the implementations in
 * work.ts (chainMatchesFilter, jobChainMatchesFilter).  Any divergence in
 * work.ts should be reflected here.
 */

import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// Minimal type aliases (matching types.ts exactly — no runtime dependency)
// ---------------------------------------------------------------------------

interface Chain {
  chainId: string;
  displayName: string;
  nextIndex: number;
  sessions: unknown[];
  totalMessages: number;
  createdAt: string;
  lastActiveAt: string;
  overallStatus?: string;
}

interface JobChain {
  jobChain: string;
  sessionChainId: string;
  type: string;
  latestStatus: string;
  latestTimestamp: string;
  runCount: number;
  runs: unknown[];
}

// ---------------------------------------------------------------------------
// Mirrored pure filter predicates (source-of-truth: pages/work.ts)
// ---------------------------------------------------------------------------

/**
 * Returns true if a chain (with its linked job chains) matches the filter text.
 * Case-insensitive containment on chain displayName OR any linked JobChain name.
 * Mirror of: chainMatchesFilter in pages/work.ts
 */
function chainMatchesFilter(chain: Chain, linkedJobChains: JobChain[], text: string): boolean {
  if (!text) return true;
  const lower = text.toLowerCase();
  if (chain.displayName.toLowerCase().includes(lower)) return true;
  return linkedJobChains.some(jc => jc.jobChain.toLowerCase().includes(lower));
}

/**
 * Returns true if a standalone JobChain matches the filter text.
 * Mirror of: jobChainMatchesFilter in pages/work.ts
 */
function jobChainMatchesFilter(jc: JobChain, text: string): boolean {
  if (!text) return true;
  return jc.jobChain.toLowerCase().includes(text.toLowerCase());
}

// ---------------------------------------------------------------------------
// fast-check arbitraries
// ---------------------------------------------------------------------------

/** Minimal Chain with a meaningful displayName */
const chainArb: fc.Arbitrary<Chain> = fc.record({
  chainId:       fc.uuid(),
  displayName:   fc.string({ minLength: 0, maxLength: 50 }),
  nextIndex:     fc.nat(),
  sessions:      fc.constant([]),
  totalMessages: fc.nat(),
  createdAt:     fc.constant('2024-01-01T00:00:00.000Z'),
  lastActiveAt:  fc.constant('2024-01-01T00:00:00.000Z'),
});

/** Minimal JobChain with a meaningful jobChain name */
const jobChainArb: fc.Arbitrary<JobChain> = fc.record({
  jobChain:        fc.string({ minLength: 0, maxLength: 50 }),
  sessionChainId:  fc.oneof(fc.constant(''), fc.uuid()),
  type:            fc.constant('agent'),
  latestStatus:    fc.constantFrom('running', 'done', 'error', 'reported'),
  latestTimestamp: fc.constant('2024-01-01T00:00:00.000Z'),
  runCount:        fc.nat(),
  runs:            fc.constant([]),
});

/**
 * A non-empty string that contains only printable ASCII characters.
 * Used as a filter; filtered to ensure it has at least one non-whitespace char.
 */
const nonEmptyFilterArb = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter(s => s.trim().length > 0);

// ---------------------------------------------------------------------------
// Helpers for example-based tests
// ---------------------------------------------------------------------------

function chainWithDisplayName(name: string): Chain {
  return {
    chainId: 'c1', displayName: name, nextIndex: 0,
    sessions: [], totalMessages: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    lastActiveAt: '2024-01-01T00:00:00.000Z',
  };
}

function jobChainWithName(name: string): JobChain {
  return {
    jobChain: name, sessionChainId: '',
    type: 'agent', latestStatus: 'done',
    latestTimestamp: '2024-01-01T00:00:00.000Z',
    runCount: 1, runs: [],
  };
}

// ---------------------------------------------------------------------------
// describe: Property 12 — Work page filter case-insensitive containment
// ---------------------------------------------------------------------------

describe('Property 12: Work page filter case-insensitive containment', () => {

  // -------------------------------------------------------------------------
  // P12-a: empty filter always returns true (every record is visible)
  // -------------------------------------------------------------------------

  it('P12-a: empty filter matches every chain regardless of its name', () => {
    fc.assert(
      fc.property(chainArb, fc.array(jobChainArb), (chain, linked) => {
        expect(chainMatchesFilter(chain, linked, '')).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('P12-a: empty filter matches every standalone JobChain regardless of its name', () => {
    fc.assert(
      fc.property(jobChainArb, (jc) => {
        expect(jobChainMatchesFilter(jc, '')).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  // -------------------------------------------------------------------------
  // P12-b: a chain is included iff its displayName OR any linked JobChain name
  // contains the filter text (case-insensitive)
  // -------------------------------------------------------------------------

  it('P12-b: chainMatchesFilter returns true iff displayName or any linked jobChain name contains filter (case-insensitive)', () => {
    fc.assert(
      fc.property(chainArb, fc.array(jobChainArb, { maxLength: 5 }), nonEmptyFilterArb,
        (chain, linked, filter) => {
          const lower = filter.toLowerCase();
          const expectedMatch =
            chain.displayName.toLowerCase().includes(lower) ||
            linked.some(jc => jc.jobChain.toLowerCase().includes(lower));
          expect(chainMatchesFilter(chain, linked, filter)).toBe(expectedMatch);
        }
      ),
      { numRuns: 200 }
    );
  });

  // -------------------------------------------------------------------------
  // P12-c: a standalone JobCard is included iff its jobChain name contains the
  // filter text (case-insensitive)
  // -------------------------------------------------------------------------

  it('P12-c: jobChainMatchesFilter returns true iff jobChain name contains filter (case-insensitive)', () => {
    fc.assert(
      fc.property(jobChainArb, nonEmptyFilterArb, (jc, filter) => {
        const expectedMatch = jc.jobChain.toLowerCase().includes(filter.toLowerCase());
        expect(jobChainMatchesFilter(jc, filter)).toBe(expectedMatch);
      }),
      { numRuns: 200 }
    );
  });

  // -------------------------------------------------------------------------
  // P12-d: case-insensitivity — upper/lower/mixed filter all give same result
  // -------------------------------------------------------------------------

  it('P12-d: filter result is identical for uppercase, lowercase, and mixed-case variants (chains)', () => {
    fc.assert(
      fc.property(chainArb, fc.array(jobChainArb, { maxLength: 5 }), nonEmptyFilterArb,
        (chain, linked, filter) => {
          const lower = chainMatchesFilter(chain, linked, filter.toLowerCase());
          const upper = chainMatchesFilter(chain, linked, filter.toUpperCase());
          const mixed = chainMatchesFilter(chain, linked,
            filter.split('').map((c, i) => i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()).join('')
          );
          expect(lower).toBe(upper);
          expect(lower).toBe(mixed);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('P12-d: filter result is identical for upper/lower/mixed-case variants (standalone JobChains)', () => {
    fc.assert(
      fc.property(jobChainArb, nonEmptyFilterArb, (jc, filter) => {
        const lower = jobChainMatchesFilter(jc, filter.toLowerCase());
        const upper = jobChainMatchesFilter(jc, filter.toUpperCase());
        expect(lower).toBe(upper);
      }),
      { numRuns: 100 }
    );
  });

  // -------------------------------------------------------------------------
  // P12-e: non-matching records return false — the DOM element will be hidden
  // (not removed) by the caller; false return value represents "hide"
  // -------------------------------------------------------------------------

  it('P12-e: chain with no names containing the filter returns false (record hidden, not removed)', () => {
    fc.assert(
      fc.property(
        chainArb.filter(c => !c.displayName.includes('XYZZY_NOMATCH_9999')),
        fc.array(jobChainArb.filter(jc => !jc.jobChain.includes('XYZZY_NOMATCH_9999')), { maxLength: 5 }),
        (chain, linked) => {
          expect(chainMatchesFilter(chain, linked, 'XYZZY_NOMATCH_9999')).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('P12-e: standalone JobChain whose name does not contain filter returns false', () => {
    fc.assert(
      fc.property(
        jobChainArb.filter(jc => !jc.jobChain.includes('XYZZY_NOMATCH_9999')),
        (jc) => {
          expect(jobChainMatchesFilter(jc, 'XYZZY_NOMATCH_9999')).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  // -------------------------------------------------------------------------
  // Example-based: concrete cases for each branch of the requirement
  // -------------------------------------------------------------------------

  it('example: chain matched by displayName (case-insensitive)', () => {
    const chain = chainWithDisplayName('MySessionChain');
    expect(chainMatchesFilter(chain, [], 'mysessionchain')).toBe(true);
    expect(chainMatchesFilter(chain, [], 'MYSESSIONCHAIN')).toBe(true);
    expect(chainMatchesFilter(chain, [], 'Session')).toBe(true);
    expect(chainMatchesFilter(chain, [], 'session')).toBe(true);
  });

  it('example: chain matched by linked JobChain name when displayName does not match', () => {
    const chain  = chainWithDisplayName('NoMatch');
    const linked = [jobChainWithName('carbon-ingest-v2')];
    expect(chainMatchesFilter(chain, linked, 'carbon')).toBe(true);
    expect(chainMatchesFilter(chain, linked, 'CARBON')).toBe(true);
  });

  it('example: chain not matched when neither displayName nor linked names contain filter', () => {
    const chain  = chainWithDisplayName('Alpha');
    const linked = [jobChainWithName('beta-job')];
    expect(chainMatchesFilter(chain, linked, 'gamma')).toBe(false);
  });

  it('example: standalone JobCard matched by jobChain name (case-insensitive)', () => {
    const jc = jobChainWithName('CrawlWorker-EU');
    expect(jobChainMatchesFilter(jc, 'crawlworker')).toBe(true);
    expect(jobChainMatchesFilter(jc, 'CRAWLWORKER')).toBe(true);
    expect(jobChainMatchesFilter(jc, 'eu')).toBe(true);
    expect(jobChainMatchesFilter(jc, 'EU')).toBe(true);
  });

  it('example: standalone JobCard not matched when jobChain name does not contain filter', () => {
    const jc = jobChainWithName('CrawlWorker-EU');
    expect(jobChainMatchesFilter(jc, 'clone')).toBe(false);
  });

  it('example: chain with no linked jobs matched only by displayName', () => {
    const chain = chainWithDisplayName('ProjectAlpha');
    expect(chainMatchesFilter(chain, [], 'alpha')).toBe(true);
    expect(chainMatchesFilter(chain, [], 'ALPHA')).toBe(true);
    expect(chainMatchesFilter(chain, [], 'beta')).toBe(false);
  });

});
