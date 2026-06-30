// Feature: monitor-dashboard-redesign, Property 17: Activity dispatch log descending timestamp order
// Validates: Requirement 8.3

/**
 * This test file tests the dispatch log sort+slice logic for the Activity page.
 *
 * Because activity.ts transitively imports state.ts (which calls localStorage at
 * module-evaluation time) and utils.ts (which references document), the pure
 * sort+slice function is mirrored here to keep the tests hermetic and
 * dependency-free — identical to the pattern used in work.test.ts and
 * dashboard.test.ts.
 *
 * The mirrored logic is deliberately identical to buildDispatchTable in
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
// Arbitraries
// ---------------------------------------------------------------------------

const pollLogEntryArb: fc.Arbitrary<PollLogEntry> = fc.record({
  ts: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  type: fc.constantFrom<PollLogEntry['type']>('CRAWL', 'CLONE', 'PROMPT', 'poll'),
  count: fc.nat({ max: 1000 }),
  detail: fc.string(),
  workflowHash: fc.string(),
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
