// Feature: monitor-dashboard-redesign, Property 15: RunTimeline dot colour by status
// Validates: Requirement 15.2

import * as fc from 'fast-check';
import { test, expect, describe } from 'bun:test';
import { statusToClass } from '../src/dashboard/utils.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** The four known status values */
const knownStatuses = ['done', 'error', 'running', 'reported'] as const;

/** Any status value the spec explicitly maps */
const knownStatusArb = fc.constantFrom(...knownStatuses);

/** Any string that is NOT one of the four known statuses */
const otherStatusArb = fc.string().filter(
  (s) => !knownStatuses.includes(s as (typeof knownStatuses)[number]),
);

/** Any arbitrary string — used to build a timeline of varied statuses */
const anyStatusArb = fc.oneof(
  knownStatusArb,
  otherStatusArb,
);

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe('statusToClass — property tests (Property 15)', () => {
  /**
   * Validates: Requirement 15.2
   * For any number of adjacent runs, `done` always maps to the green class.
   * We pick an arbitrary array of other statuses to place around the target run,
   * confirming position and neighbours do not affect the mapping.
   */
  test('P15.1: status "done" always returns run-dot--done, regardless of position', () => {
    fc.assert(
      fc.property(
        fc.array(anyStatusArb), // statuses before
        fc.array(anyStatusArb), // statuses after
        (_before, _after) => {
          expect(statusToClass('done')).toBe('run-dot--done');
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirement 15.2
   * For any number of adjacent runs, `error` always maps to the red class.
   */
  test('P15.2: status "error" always returns run-dot--error, regardless of position', () => {
    fc.assert(
      fc.property(
        fc.array(anyStatusArb),
        fc.array(anyStatusArb),
        (_before, _after) => {
          expect(statusToClass('error')).toBe('run-dot--error');
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirement 15.2
   * For any number of adjacent runs, `running` always maps to the blue class.
   */
  test('P15.3: status "running" always returns run-dot--running, regardless of position', () => {
    fc.assert(
      fc.property(
        fc.array(anyStatusArb),
        fc.array(anyStatusArb),
        (_before, _after) => {
          expect(statusToClass('running')).toBe('run-dot--running');
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirement 15.2
   * For any number of adjacent runs, `reported` always maps to the amber class.
   */
  test('P15.4: status "reported" always returns run-dot--reported, regardless of position', () => {
    fc.assert(
      fc.property(
        fc.array(anyStatusArb),
        fc.array(anyStatusArb),
        (_before, _after) => {
          expect(statusToClass('reported')).toBe('run-dot--reported');
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirement 15.2
   * For any string that is not one of the four known statuses,
   * statusToClass always returns run-dot--other (grey).
   * Tests with arbitrary adjacent runs to confirm position-independence.
   */
  test('P15.5: any other status value always returns run-dot--other (grey)', () => {
    fc.assert(
      fc.property(
        otherStatusArb,
        fc.array(anyStatusArb),
        fc.array(anyStatusArb),
        (status, _before, _after) => {
          expect(statusToClass(status)).toBe('run-dot--other');
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirement 15.2
   * The mapping function is a total function: every possible string input maps to
   * exactly one of the five expected class names and never throws.
   */
  test('P15.6: statusToClass never throws and always returns a valid class name', () => {
    const validClasses = new Set([
      'run-dot--done',
      'run-dot--error',
      'run-dot--running',
      'run-dot--reported',
      'run-dot--other',
    ]);

    fc.assert(
      fc.property(fc.string(), (status) => {
        let result: string;
        expect(() => { result = statusToClass(status); }).not.toThrow();
        expect(validClasses.has(statusToClass(status))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Example-based tests — explicit mapping verification
// ---------------------------------------------------------------------------

describe('statusToClass — example-based tests (Property 15)', () => {
  /** Validates: Requirement 15.2 — done → green */
  test('"done" → run-dot--done', () => {
    expect(statusToClass('done')).toBe('run-dot--done');
  });

  /** Validates: Requirement 15.2 — error → red */
  test('"error" → run-dot--error', () => {
    expect(statusToClass('error')).toBe('run-dot--error');
  });

  /** Validates: Requirement 15.2 — running → blue */
  test('"running" → run-dot--running', () => {
    expect(statusToClass('running')).toBe('run-dot--running');
  });

  /** Validates: Requirement 15.2 — reported → amber */
  test('"reported" → run-dot--reported', () => {
    expect(statusToClass('reported')).toBe('run-dot--reported');
  });

  /** Validates: Requirement 15.2 — unknown string → grey */
  test('"pending" → run-dot--other (grey)', () => {
    expect(statusToClass('pending')).toBe('run-dot--other');
  });

  /** Validates: Requirement 15.2 — empty string → grey */
  test('"" (empty) → run-dot--other (grey)', () => {
    expect(statusToClass('')).toBe('run-dot--other');
  });

  /** Validates: Requirement 15.2 — arbitrary unknown string → grey */
  test('"unknown-xyz" → run-dot--other (grey)', () => {
    expect(statusToClass('unknown-xyz')).toBe('run-dot--other');
  });
});

// ---------------------------------------------------------------------------
// Property 16: RunTimeline dot ordering is ascending by timestamp
// Feature: monitor-dashboard-redesign, Property 16: RunTimeline dot ordering is ascending by timestamp
// Validates: Requirement 15.1
// ---------------------------------------------------------------------------

import { sortRunsByTimestamp } from '../src/dashboard/utils.js';
import type { Job } from '../src/dashboard/types.js';

/**
 * Minimal Job-like record for ordering tests — only `id` and `timestamp` are
 * needed; all other Job fields are irrelevant for the sort property.
 */
type RunStub = Pick<Job, 'id' | 'timestamp'>;

/**
 * Arbitrary: generates a distinct ISO 8601 timestamp as a full Date string.
 * We derive ISO strings from arbitrary integers (ms since epoch) so that
 * fast-check can shrink effectively and timestamps are always valid.
 */
const isoTimestampArb = fc.integer({ min: 0, max: 253_402_300_799_000 })
  .map((ms) => new Date(ms).toISOString());

/**
 * Arbitrary: generates a RunStub with a unique id and an arbitrary timestamp.
 */
const runStubArb: fc.Arbitrary<RunStub> = fc.record({
  id:        fc.uuid(),
  timestamp: isoTimestampArb,
});

describe('sortRunsByTimestamp — property tests (Property 16)', () => {
  /**
   * Validates: Requirement 15.1
   * P16.1: For any array of runs, the result is sorted ascending by timestamp
   * (each element's timestamp is ≤ the next element's timestamp).
   */
  test('P16.1: sorted result is in non-decreasing timestamp order', () => {
    fc.assert(
      fc.property(fc.array(runStubArb, { minLength: 0, maxLength: 50 }), (runs) => {
        const sorted = sortRunsByTimestamp(runs);
        for (let i = 1; i < sorted.length; i++) {
          const prev = new Date(sorted[i - 1]!.timestamp).getTime();
          const curr = new Date(sorted[i]!.timestamp).getTime();
          expect(prev).toBeLessThanOrEqual(curr);
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirement 15.1
   * P16.2: The sorted result contains exactly the same elements as the input
   * (no runs omitted or duplicated — only order changes).
   */
  test('P16.2: sorted result contains the same runs as input (same ids)', () => {
    fc.assert(
      fc.property(fc.array(runStubArb, { minLength: 0, maxLength: 50 }), (runs) => {
        const sorted = sortRunsByTimestamp(runs);
        expect(sorted).toHaveLength(runs.length);
        const inputIds  = runs.map((r) => r.id).sort();
        const sortedIds = sorted.map((r) => r.id).sort();
        expect(sortedIds).toEqual(inputIds);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirement 15.1
   * P16.3: sortRunsByTimestamp does not mutate the original array.
   */
  test('P16.3: original runs array is not mutated by the sort', () => {
    fc.assert(
      fc.property(fc.array(runStubArb, { minLength: 1, maxLength: 50 }), (runs) => {
        const copy   = runs.map((r) => ({ ...r }));
        sortRunsByTimestamp(runs);
        // Original array order should be unchanged
        for (let i = 0; i < runs.length; i++) {
          expect(runs[i]!.id).toBe(copy[i]!.id);
          expect(runs[i]!.timestamp).toBe(copy[i]!.timestamp);
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirement 15.1
   * P16.4: Any permutation of runs with distinct timestamps produces the same
   * ascending sequence. We enforce distinct timestamps so there is exactly one
   * valid sorted order to compare against.
   */
  test('P16.4: any permutation of runs produces the same ascending sequence', () => {
    // Generate runs with guaranteed distinct timestamps by mapping unique integers
    const distinctRunsArb = fc
      .uniqueArray(fc.integer({ min: 0, max: 253_402_300_799_000 }), {
        minLength: 2,
        maxLength: 20,
      })
      .map((msList) =>
        msList.map((ms, i) => ({
          id:        `run-${i}`,
          timestamp: new Date(ms).toISOString(),
        })),
      );

    fc.assert(
      fc.property(distinctRunsArb, (runs) => {
        // Sort one canonical reference
        const reference = sortRunsByTimestamp(runs);
        // Reverse and re-sort — must produce the same ordered sequence
        const shuffled = [...runs].reverse();
        const reSorted = sortRunsByTimestamp(shuffled);
        expect(reSorted.map((r) => r.id)).toEqual(reference.map((r) => r.id));
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Example-based tests — specific ordering scenarios (Property 16)
// ---------------------------------------------------------------------------

describe('sortRunsByTimestamp — example-based tests (Property 16)', () => {
  /** Validates: Requirement 15.1 — empty array stays empty */
  test('empty runs[] → empty sorted array', () => {
    expect(sortRunsByTimestamp([])).toEqual([]);
  });

  /** Validates: Requirement 15.1 — single-element array is unchanged */
  test('single run → same single run returned', () => {
    const run: RunStub = { id: 'a', timestamp: '2024-01-01T00:00:00.000Z' };
    const result = sortRunsByTimestamp([run]);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('a');
  });

  /** Validates: Requirement 15.1 — already-ascending input is preserved */
  test('already-ascending input → unchanged order', () => {
    const runs: RunStub[] = [
      { id: 'a', timestamp: '2024-01-01T00:00:00.000Z' },
      { id: 'b', timestamp: '2024-01-02T00:00:00.000Z' },
      { id: 'c', timestamp: '2024-01-03T00:00:00.000Z' },
    ];
    const sorted = sortRunsByTimestamp(runs);
    expect(sorted.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  /** Validates: Requirement 15.1 — descending input is reversed */
  test('descending input → reversed to ascending', () => {
    const runs: RunStub[] = [
      { id: 'c', timestamp: '2024-01-03T00:00:00.000Z' },
      { id: 'b', timestamp: '2024-01-02T00:00:00.000Z' },
      { id: 'a', timestamp: '2024-01-01T00:00:00.000Z' },
    ];
    const sorted = sortRunsByTimestamp(runs);
    expect(sorted.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  /** Validates: Requirement 15.1 — random-order input is correctly sorted */
  test('out-of-order input → sorted ascending (oldest left, newest right)', () => {
    const runs: RunStub[] = [
      { id: 'b', timestamp: '2024-03-15T12:00:00.000Z' },
      { id: 'a', timestamp: '2024-01-01T00:00:00.000Z' },
      { id: 'd', timestamp: '2024-12-31T23:59:59.000Z' },
      { id: 'c', timestamp: '2024-06-01T08:30:00.000Z' },
    ];
    const sorted = sortRunsByTimestamp(runs);
    expect(sorted.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  /** Validates: Requirement 15.1 — original array is not mutated */
  test('original array order is preserved after sort', () => {
    const runs: RunStub[] = [
      { id: 'z', timestamp: '2024-12-01T00:00:00.000Z' },
      { id: 'a', timestamp: '2024-01-01T00:00:00.000Z' },
    ];
    sortRunsByTimestamp(runs);
    expect(runs[0]!.id).toBe('z');
    expect(runs[1]!.id).toBe('a');
  });
});
