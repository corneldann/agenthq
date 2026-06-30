// Feature: monitor-dashboard-redesign
// Property 14: ContextRing colour threshold correctness
// Validates: Requirements 14.2, 14.3, 14.4, 14.5

import * as fc from 'fast-check';
import { test, expect, describe } from 'bun:test';
import { contextColour } from '../src/dashboard/utils.js';

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe('contextColour — property tests', () => {
  /**
   * Validates: Requirements 14.2
   * For any integer in 0–49: contextColour(pct) === 'green'
   */
  test('P14.1: pct in [0, 49] → green', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 49 }), (pct) => {
        expect(contextColour(pct)).toBe('green');
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 14.3
   * For any integer in 50–69: contextColour(pct) === 'amber'
   */
  test('P14.2: pct in [50, 69] → amber', () => {
    fc.assert(
      fc.property(fc.integer({ min: 50, max: 69 }), (pct) => {
        expect(contextColour(pct)).toBe('amber');
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 14.4
   * For any integer in 70–100: contextColour(pct) === 'red'
   */
  test('P14.3: pct in [70, 100] → red', () => {
    fc.assert(
      fc.property(fc.integer({ min: 70, max: 100 }), (pct) => {
        expect(contextColour(pct)).toBe('red');
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 14.5
   * For any integer outside 0–100: contextColour(pct) === 'grey'
   */
  test('P14.4: pct outside [0, 100] → grey', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer({ max: -1 }), fc.integer({ min: 101 })),
        (pct) => {
          expect(contextColour(pct)).toBe('grey');
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Example-based tests — boundary values
// ---------------------------------------------------------------------------

describe('contextColour — boundary examples', () => {
  /** Validates: Requirements 14.5 — out-of-range below */
  test('contextColour(-1) → grey', () => {
    expect(contextColour(-1)).toBe('grey');
  });

  /** Validates: Requirements 14.2 — lower boundary */
  test('contextColour(0) → green', () => {
    expect(contextColour(0)).toBe('green');
  });

  /** Validates: Requirements 14.2 — upper boundary of green */
  test('contextColour(49) → green', () => {
    expect(contextColour(49)).toBe('green');
  });

  /** Validates: Requirements 14.3 — lower boundary of amber */
  test('contextColour(50) → amber', () => {
    expect(contextColour(50)).toBe('amber');
  });

  /** Validates: Requirements 14.3 — upper boundary of amber */
  test('contextColour(69) → amber', () => {
    expect(contextColour(69)).toBe('amber');
  });

  /** Validates: Requirements 14.4 — lower boundary of red */
  test('contextColour(70) → red', () => {
    expect(contextColour(70)).toBe('red');
  });

  /** Validates: Requirements 14.4 — upper boundary of red */
  test('contextColour(100) → red', () => {
    expect(contextColour(100)).toBe('red');
  });

  /** Validates: Requirements 14.5 — out-of-range above */
  test('contextColour(101) → grey', () => {
    expect(contextColour(101)).toBe('grey');
  });

  /** Validates: Requirements 14.5 — absent session (null pct) → grey */
  test('contextColour(null) → grey', () => {
    expect(contextColour(null)).toBe('grey');
  });
});

// ---------------------------------------------------------------------------
// Absent session boundary
// ---------------------------------------------------------------------------

describe('contextColour — absent session', () => {
  /** Validates: Requirements 14.5 — null represents no active session */
  test('null pct always returns grey regardless of context', () => {
    expect(contextColour(null)).toBe('grey');
  });
});
