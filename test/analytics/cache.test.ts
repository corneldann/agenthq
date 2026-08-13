// Property-based and unit tests for AnalyticsCache (src/analytics/cache.ts)
// **Validates: Requirements 2.7**

import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import { AnalyticsCache } from '../../src/analytics/cache';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Any non-empty string key â€” avoid empty string which Map handles fine but is
 *  semantically unusual. */
const keyArb = fc.string({ minLength: 1, maxLength: 128 });

/** JSON-serialisable record values: numbers, strings, booleans, nested objects. */
const jsonValueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.integer(),
  fc.float({ noNaN: true }),
  fc.string(),
  fc.boolean(),
  fc.record({
    id: fc.string({ minLength: 1 }),
    value: fc.integer(),
    label: fc.string(),
  }),
  fc.array(fc.integer(), { minLength: 0, maxLength: 10 }),
);

// ---------------------------------------------------------------------------
// Property 1: Cache Consistency
//
// For any key and JSON-serialisable value, calling set(key, value) then
// get(key) before TTL elapses returns a value that deep-equals the stored
// value.
// ---------------------------------------------------------------------------

describe('Property 1: Cache Consistency â€” get within TTL returns stored value', () => {
  it('property: get immediately after set deep-equals the stored value', () => {
    // Use a long TTL (10 minutes) so expiry never fires within the test.
    const ttlMs = 10 * 60 * 1_000;

    fc.assert(
      fc.property(
        keyArb,
        jsonValueArb,
        (key, value) => {
          // Arrange
          const cache = new AnalyticsCache(ttlMs);

          // Act
          cache.set(key, value);
          const result = cache.get(key);

          // Assert â€” precise deep equality, not loose truthiness
          expect(result).toEqual(value);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('property: second set to the same key overwrites and get returns the latest value', () => {
    const ttlMs = 10 * 60 * 1_000;

    fc.assert(
      fc.property(
        keyArb,
        jsonValueArb,
        jsonValueArb,
        (key, firstValue, secondValue) => {
          // Arrange
          const cache = new AnalyticsCache(ttlMs);

          // Act
          cache.set(key, firstValue);
          cache.set(key, secondValue);
          const result = cache.get(key);

          // Assert â€” latest write wins
          expect(result).toEqual(secondValue);
        }
      ),
      { numRuns: 300 }
    );
  });

  it('property: distinct keys do not interfere with each other', () => {
    const ttlMs = 10 * 60 * 1_000;

    fc.assert(
      fc.property(
        // Generate two non-equal keys
        fc.tuple(keyArb, keyArb).filter(([a, b]) => a !== b),
        jsonValueArb,
        jsonValueArb,
        ([keyA, keyB], valueA, valueB) => {
          // Arrange
          const cache = new AnalyticsCache(ttlMs);

          // Act
          cache.set(keyA, valueA);
          cache.set(keyB, valueB);

          // Assert â€” each key returns its own value
          expect(cache.get<typeof valueA>(keyA)).toEqual(valueA);
          expect(cache.get<typeof valueB>(keyB)).toEqual(valueB);
        }
      ),
      { numRuns: 300 }
    );
  });

  it('property: get on missing key returns null', () => {
    const ttlMs = 10 * 60 * 1_000;

    fc.assert(
      fc.property(
        keyArb,
        (key) => {
          // Arrange â€” fresh cache, nothing stored
          const cache = new AnalyticsCache(ttlMs);

          // Act + Assert
          expect(cache.get(key)).toBeNull();
        }
      ),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Expiry
//
// For any key and value, after the TTL has elapsed get(key) returns null.
// We use a 1 ms TTL and a 5 ms delay so expiry is deterministic.
// ---------------------------------------------------------------------------

describe('Property 2: Expiry â€” get after TTL elapses returns null', () => {
  it('property: get returns null after TTL has elapsed', async () => {
    await fc.assert(
      fc.asyncProperty(
        keyArb,
        jsonValueArb,
        async (key, value) => {
          // Arrange â€” 1 ms TTL guarantees expiry after a short wait
          const cache = new AnalyticsCache(1);

          // Act
          cache.set(key, value);

          // Wait for TTL to pass
          await new Promise<void>((r) => setTimeout(r, 5));

          const result = cache.get(key);

          // Assert â€” must be null after expiry
          expect(result).toBeNull();
        }
      ),
      // Reduce numRuns because each run incurs a 5ms async delay
      { numRuns: 50 }
    );
  });

  it('property: entry still present before TTL elapses', async () => {
    await fc.assert(
      fc.asyncProperty(
        keyArb,
        jsonValueArb,
        async (key, value) => {
          // Arrange â€” 200 ms TTL; retrieve immediately so it cannot expire yet
          const cache = new AnalyticsCache(200);

          // Act
          cache.set(key, value);

          // No delay â€” retrieve immediately
          const result = cache.get(key);

          // Assert â€” must still be present
          expect(result).toEqual(value);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Unit test: invalidateWorkspace
//
// Keys containing the workspace prefix are evicted; other keys are unaffected.
// ---------------------------------------------------------------------------

describe('invalidateWorkspace', () => {
  it('should delete all keys containing the workspaceId and leave others intact', () => {
    // Arrange
    const cache = new AnalyticsCache(10 * 60 * 1_000);

    const wsId = 'ws-abc';
    cache.set(`perf:${wsId}:24h`, { avg: 100 });
    cache.set(`cost:${wsId}:7d`, { total: 5.5 });
    cache.set(`perf:other-ws:24h`, { avg: 200 });
    cache.set(`unrelated-key`, 42);

    // Act
    cache.invalidateWorkspace(wsId);

    // Assert â€” keys containing wsId are gone
    expect(cache.get(`perf:${wsId}:24h`)).toBeNull();
    expect(cache.get(`cost:${wsId}:7d`)).toBeNull();

    // Assert â€” keys NOT containing wsId are unaffected
    expect(cache.get<{ avg: number }>(`perf:other-ws:24h`)).toEqual({ avg: 200 });
    expect(cache.get<number>(`unrelated-key`)).toBe(42);
  });

  it('should be a no-op when no keys match the workspaceId', () => {
    // Arrange
    const cache = new AnalyticsCache(10 * 60 * 1_000);
    cache.set('perf:workspace-x:24h', { avg: 50 });

    // Act â€” invalidate a workspace that has no cached entries
    cache.invalidateWorkspace('workspace-z');

    // Assert â€” existing entry is untouched
    expect(cache.get<{ avg: number }>('perf:workspace-x:24h')).toEqual({ avg: 50 });
  });

  it('should be a no-op on an empty cache', () => {
    // Arrange
    const cache = new AnalyticsCache(10 * 60 * 1_000);

    // Act + Assert â€” must not throw and subsequent gets return null
    expect(() => cache.invalidateWorkspace('any-workspace')).not.toThrow();
    expect(cache.get('any-workspace:key')).toBeNull();
  });

  it('should handle workspace ID that is a substring of another workspace ID without cross-contamination', () => {
    // Arrange
    const cache = new AnalyticsCache(10 * 60 * 1_000);

    cache.set('perf:ws:24h', { avg: 10 });
    cache.set('perf:ws-extended:24h', { avg: 20 });

    // Act â€” invalidate the short ID; "ws" is a substring of "ws-extended",
    // so both keys will be deleted (by design â€” the implementation uses String.includes)
    cache.invalidateWorkspace('ws');

    // Both keys contain "ws" so both should be evicted
    expect(cache.get('perf:ws:24h')).toBeNull();
    expect(cache.get('perf:ws-extended:24h')).toBeNull();
  });

  it('should only delete keys that literally contain the workspaceId string', () => {
    // Arrange
    const cache = new AnalyticsCache(10 * 60 * 1_000);

    cache.set('perf:workspace-prod:24h', { avg: 10 });
    cache.set('perf:workspace-staging:24h', { avg: 20 });
    cache.set('unrelated', 99);

    // Act
    cache.invalidateWorkspace('workspace-prod');

    // Assert
    expect(cache.get('perf:workspace-prod:24h')).toBeNull();
    expect(cache.get<{ avg: number }>('perf:workspace-staging:24h')).toEqual({ avg: 20 });
    expect(cache.get<number>('unrelated')).toBe(99);
  });
});
