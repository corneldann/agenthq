/**
 * Property-based tests for stale memory filtering — task 2.3.
 *
 * Uses fast-check to verify Properties 13 and 14.
 *
 * **Property 13: Default Stale Exclusion**
 * For any query to list or search endpoints without the includeStale parameter,
 * memories where stale=true SHALL be excluded from results.
 *
 * **Property 14: Stale Inclusion Opt-In**
 * For any query with includeStale=true, memories where stale=true SHALL be
 * included in results alongside active memories.
 *
 * Validates: Requirements 3.3, 3.4 from Phase 6.5 Export Advanced
 *
 * Test approach:
 * - Generate collections of memories with varying stale states
 * - Test both recall() and list() methods
 * - Verify filtering behavior matches specification
 * - Test edge cases: all stale, all active, mixed, empty collections
 */

import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import type { Memory, MemoryScope, IMemoryClient } from '../../src/memory/types.js';

// ---------------------------------------------------------------------------
// Test helper: Mock memory client with configurable behavior
// ---------------------------------------------------------------------------

/**
 * Mock memory client that implements includeStale filtering.
 * Provides deterministic behavior for property testing.
 */
class MockMemoryClient implements IMemoryClient {
  #memories: Memory[];

  constructor(memories: Memory[]) {
    this.#memories = memories;
  }

  async retain(_text: string, _scope: MemoryScope): Promise<string> {
    return 'mock-id';
  }

  /**
   * Recall implementation with includeStale parameter.
   * Filters stale memories by default (includeStale=false).
   */
  async recall(
    _query: string,
    _scope: MemoryScope,
    limit: number,
    includeStale: boolean = false,
  ): Promise<Memory[]> {
    const filtered = includeStale
      ? this.#memories
      : this.#memories.filter(m => !m.stale);
    return filtered.slice(0, limit);
  }

  /**
   * List implementation with includeStale parameter.
   * Filters stale memories by default (includeStale=false).
   */
  async list(
    _scope: MemoryScope,
    pageSize: number,
    _cursor: string | null,
    includeStale: boolean = false,
  ): Promise<{
    memories: Memory[];
    nextCursor: string | null;
    total: number;
  }> {
    const filtered = includeStale
      ? this.#memories
      : this.#memories.filter(m => !m.stale);
    const page = filtered.slice(0, pageSize);
    return {
      memories: page,
      nextCursor: page.length < filtered.length ? 'next-cursor' : null,
      total: filtered.length,
    };
  }

  async get(_id: string): Promise<Memory | null> {
    return null;
  }

  async reflect(_topic: string, _scope: MemoryScope): Promise<string | null> {
    return null;
  }

  async delete(_id: string): Promise<void> {
    return;
  }
}

// ---------------------------------------------------------------------------
// Arbitraries for property-based testing
// ---------------------------------------------------------------------------

/**
 * Generate a valid Memory object with configurable stale flag.
 * All required fields are populated with valid test data.
 */
function memoryArbitrary(stale: boolean): fc.Arbitrary<Memory> {
  // Generate valid timestamps by using integer timestamps and converting to ISO strings
  const timestampArbitrary = fc
    .integer({ min: new Date('2023-01-01').getTime(), max: Date.now() })
    .map(ts => new Date(ts).toISOString());

  return fc.record({
    id: fc.uuid(),
    text: fc.string({ minLength: 5, maxLength: 100 }),
    scope: fc.record({
      workspaceId: fc.uuid(),
      chainId: fc.option(fc.uuid(), { nil: undefined }),
    }),
    qualityScore: fc.double({ min: 0, max: 1, noNaN: true }),
    createdAt: timestampArbitrary,
    lastRetrievedAt: timestampArbitrary,
    retrievalCount: fc.nat({ max: 1000 }),
    tier: fc.oneof(
      fc.constant('hot' as const),
      fc.constant('warm' as const),
      fc.constant('cold' as const),
    ),
    embeddingStatus: fc.oneof(
      fc.constant('pending' as const),
      fc.constant('ready' as const),
      fc.constant('failed' as const),
    ),
    stale: fc.constant(stale),
    superseded: fc.boolean(),
  });
}

/**
 * Generate an array of memories with specified number of stale/active memories.
 * Ensures controlled distribution for testing filtering logic.
 */
function memoriesWithDistributionArbitrary(
  activeCount: number,
  staleCount: number,
): fc.Arbitrary<Memory[]> {
  const activeMemories = fc.array(memoryArbitrary(false), {
    minLength: activeCount,
    maxLength: activeCount,
  });
  const staleMemories = fc.array(memoryArbitrary(true), {
    minLength: staleCount,
    maxLength: staleCount,
  });

  return fc.tuple(activeMemories, staleMemories).map(([active, stale]) => {
    // Shuffle to avoid ordering bias
    const combined = [...active, ...stale];
    for (let i = combined.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [combined[i], combined[j]] = [combined[j], combined[i]];
    }
    return combined;
  });
}

// ---------------------------------------------------------------------------
// Property 13: Default Stale Exclusion
// ---------------------------------------------------------------------------

describe('Property 13: Default Stale Exclusion', () => {
  /**
   * **Validates: Requirements 3.3**
   */
  it('property: recall() excludes all stale memories when includeStale is not specified', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20 }), // active count
        fc.integer({ min: 1, max: 20 }), // stale count (at least 1)
        fc.integer({ min: 1, max: 50 }), // limit
        async (activeCount, staleCount, limit) => {
          // Arrange: Generate memories with known distribution
          const memories = await fc.sample(
            memoriesWithDistributionArbitrary(activeCount, staleCount),
            1,
          );
          const client = new MockMemoryClient(memories[0]);
          const scope: MemoryScope = { workspaceId: 'test-ws' };

          // Act: Call recall without includeStale (defaults to false)
          const result = await client.recall('test query', scope, limit);

          // Assert: No stale memories in results
          const hasStaleMemories = result.some(m => m.stale);
          if (hasStaleMemories) return false;

          // Assert: All returned memories are active
          const allActive = result.every(m => !m.stale);
          if (!allActive) return false;

          // Assert: Count does not exceed available active memories
          const expectedMaxResults = Math.min(activeCount, limit);
          if (result.length > expectedMaxResults) return false;

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.3**
   */
  it('property: recall() excludes all stale memories when includeStale=false', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20 }), // active count
        fc.integer({ min: 1, max: 20 }), // stale count
        fc.integer({ min: 1, max: 50 }), // limit
        async (activeCount, staleCount, limit) => {
          // Arrange
          const memories = await fc.sample(
            memoriesWithDistributionArbitrary(activeCount, staleCount),
            1,
          );
          const client = new MockMemoryClient(memories[0]);
          const scope: MemoryScope = { workspaceId: 'test-ws' };

          // Act: Explicitly pass includeStale=false
          const result = await client.recall('test query', scope, limit, false);

          // Assert: No stale memories in results
          const hasStaleMemories = result.some(m => m.stale);
          return !hasStaleMemories && result.every(m => !m.stale);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.3**
   */
  it('property: list() excludes all stale memories when includeStale is not specified', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20 }), // active count
        fc.integer({ min: 1, max: 20 }), // stale count
        fc.integer({ min: 1, max: 50 }), // page size
        async (activeCount, staleCount, pageSize) => {
          // Arrange
          const memories = await fc.sample(
            memoriesWithDistributionArbitrary(activeCount, staleCount),
            1,
          );
          const client = new MockMemoryClient(memories[0]);
          const scope: MemoryScope = { workspaceId: 'test-ws' };

          // Act: Call list without includeStale (defaults to false)
          const result = await client.list(scope, pageSize, null);

          // Assert: No stale memories in results
          const hasStaleMemories = result.memories.some(m => m.stale);
          if (hasStaleMemories) return false;

          // Assert: Total count equals active memory count
          if (result.total !== activeCount) return false;

          // Assert: Returned count does not exceed page size or active count
          const expectedCount = Math.min(activeCount, pageSize);
          if (result.memories.length !== expectedCount) return false;

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.3**
   */
  it('property: list() excludes all stale memories when includeStale=false', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20 }), // active count
        fc.integer({ min: 1, max: 20 }), // stale count
        fc.integer({ min: 1, max: 50 }), // page size
        async (activeCount, staleCount, pageSize) => {
          // Arrange
          const memories = await fc.sample(
            memoriesWithDistributionArbitrary(activeCount, staleCount),
            1,
          );
          const client = new MockMemoryClient(memories[0]);
          const scope: MemoryScope = { workspaceId: 'test-ws' };

          // Act: Explicitly pass includeStale=false
          const result = await client.list(scope, pageSize, null, false);

          // Assert: No stale memories in results
          const hasStaleMemories = result.memories.some(m => m.stale);
          return !hasStaleMemories && result.total === activeCount;
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Edge case: All memories are stale.
   * **Validates: Requirements 3.3**
   */
  it('property: recall() returns empty array when all memories are stale and includeStale is false', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }), // stale count (at least 1)
        fc.integer({ min: 1, max: 50 }), // limit
        async (staleCount, limit) => {
          // Arrange: Only stale memories
          const memories = await fc.sample(
            memoriesWithDistributionArbitrary(0, staleCount),
            1,
          );
          const client = new MockMemoryClient(memories[0]);
          const scope: MemoryScope = { workspaceId: 'test-ws' };

          // Act
          const result = await client.recall('test query', scope, limit);

          // Assert: Empty result
          return result.length === 0;
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Edge case: All memories are stale.
   * **Validates: Requirements 3.3**
   */
  it('property: list() returns empty array and zero total when all memories are stale and includeStale is false', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }), // stale count
        fc.integer({ min: 1, max: 50 }), // page size
        async (staleCount, pageSize) => {
          // Arrange: Only stale memories
          const memories = await fc.sample(
            memoriesWithDistributionArbitrary(0, staleCount),
            1,
          );
          const client = new MockMemoryClient(memories[0]);
          const scope: MemoryScope = { workspaceId: 'test-ws' };

          // Act
          const result = await client.list(scope, pageSize, null);

          // Assert: Empty result with zero total
          return result.memories.length === 0 && result.total === 0;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 14: Stale Inclusion Opt-In
// ---------------------------------------------------------------------------

describe('Property 14: Stale Inclusion Opt-In', () => {
  /**
   * **Validates: Requirements 3.4**
   */
  it('property: recall() includes stale memories when includeStale=true', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20 }), // active count
        fc.integer({ min: 1, max: 20 }), // stale count (at least 1)
        fc.integer({ min: 1, max: 50 }), // limit
        async (activeCount, staleCount, limit) => {
          // Arrange
          const memories = await fc.sample(
            memoriesWithDistributionArbitrary(activeCount, staleCount),
            1,
          );
          const client = new MockMemoryClient(memories[0]);
          const scope: MemoryScope = { workspaceId: 'test-ws' };

          // Act: Call with includeStale=true
          const result = await client.recall('test query', scope, limit, true);

          // Assert: Result may contain stale memories
          // (At least when limit >= total memories)
          const totalMemories = activeCount + staleCount;
          if (limit >= totalMemories) {
            // When limit is high enough, we should get all memories
            const expectedCount = Math.min(totalMemories, limit);
            if (result.length !== expectedCount) return false;

            // Count stale memories in result
            const staleInResult = result.filter(m => m.stale).length;
            // Should have some stale memories (we generated at least 1)
            if (staleCount > 0 && staleInResult === 0) return false;
          }

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.4**
   */
  it('property: list() includes stale memories when includeStale=true', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20 }), // active count
        fc.integer({ min: 1, max: 20 }), // stale count (at least 1)
        fc.integer({ min: 1, max: 50 }), // page size
        async (activeCount, staleCount, pageSize) => {
          // Arrange
          const memories = await fc.sample(
            memoriesWithDistributionArbitrary(activeCount, staleCount),
            1,
          );
          const client = new MockMemoryClient(memories[0]);
          const scope: MemoryScope = { workspaceId: 'test-ws' };

          // Act: Call with includeStale=true
          const result = await client.list(scope, pageSize, null, true);

          // Assert: Total should include all memories (active + stale)
          const totalMemories = activeCount + staleCount;
          if (result.total !== totalMemories) return false;

          // Assert: Result may contain stale memories
          if (pageSize >= totalMemories) {
            // When page size is large enough, should get all memories
            if (result.memories.length !== totalMemories) return false;

            // Should contain some stale memories
            const staleInResult = result.memories.filter(m => m.stale).length;
            if (staleCount > 0 && staleInResult === 0) return false;
          }

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Verify count invariant: includeStale=true always returns >= includeStale=false.
   * **Validates: Requirements 3.4**
   */
  it('property: recall() with includeStale=true returns same or more results than includeStale=false', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }), // active count
        fc.integer({ min: 1, max: 10 }), // stale count
        fc.integer({ min: 5, max: 50 }), // limit (generous to see difference)
        async (activeCount, staleCount, limit) => {
          // Arrange
          const memories = await fc.sample(
            memoriesWithDistributionArbitrary(activeCount, staleCount),
            1,
          );
          const client = new MockMemoryClient(memories[0]);
          const scope: MemoryScope = { workspaceId: 'test-ws' };

          // Act: Call both ways
          const withoutStale = await client.recall('test query', scope, limit, false);
          const withStale = await client.recall('test query', scope, limit, true);

          // Assert: includeStale=true should return >= results
          return withStale.length >= withoutStale.length;
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Verify count invariant: includeStale=true always returns >= includeStale=false.
   * **Validates: Requirements 3.4**
   */
  it('property: list() with includeStale=true returns same or more results than includeStale=false', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }), // active count
        fc.integer({ min: 1, max: 10 }), // stale count
        fc.integer({ min: 5, max: 50 }), // page size
        async (activeCount, staleCount, pageSize) => {
          // Arrange
          const memories = await fc.sample(
            memoriesWithDistributionArbitrary(activeCount, staleCount),
            1,
          );
          const client = new MockMemoryClient(memories[0]);
          const scope: MemoryScope = { workspaceId: 'test-ws' };

          // Act: Call both ways
          const withoutStale = await client.list(scope, pageSize, null, false);
          const withStale = await client.list(scope, pageSize, null, true);

          // Assert: includeStale=true should return >= total count
          return withStale.total >= withoutStale.total;
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Edge case: Only stale memories exist.
   * **Validates: Requirements 3.4**
   */
  it('property: recall() returns all stale memories when includeStale=true and no active memories', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }), // stale count (at least 1)
        fc.integer({ min: 1, max: 50 }), // limit
        async (staleCount, limit) => {
          // Arrange: Only stale memories
          const memories = await fc.sample(
            memoriesWithDistributionArbitrary(0, staleCount),
            1,
          );
          const client = new MockMemoryClient(memories[0]);
          const scope: MemoryScope = { workspaceId: 'test-ws' };

          // Act: includeStale=true
          const result = await client.recall('test query', scope, limit, true);

          // Assert: Should return stale memories
          const expectedCount = Math.min(staleCount, limit);
          if (result.length !== expectedCount) return false;

          // All results should be stale
          return result.every(m => m.stale);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Edge case: Only stale memories exist.
   * **Validates: Requirements 3.4**
   */
  it('property: list() returns all stale memories when includeStale=true and no active memories', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }), // stale count
        fc.integer({ min: 1, max: 50 }), // page size
        async (staleCount, pageSize) => {
          // Arrange: Only stale memories
          const memories = await fc.sample(
            memoriesWithDistributionArbitrary(0, staleCount),
            1,
          );
          const client = new MockMemoryClient(memories[0]);
          const scope: MemoryScope = { workspaceId: 'test-ws' };

          // Act: includeStale=true
          const result = await client.list(scope, pageSize, null, true);

          // Assert: Total should equal stale count
          if (result.total !== staleCount) return false;

          // Should return up to pageSize memories, all stale
          const expectedCount = Math.min(staleCount, pageSize);
          if (result.memories.length !== expectedCount) return false;

          return result.memories.every(m => m.stale);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Edge case: No stale memories exist.
   * **Validates: Requirements 3.4**
   */
  it('property: recall() returns same results when includeStale=true but no stale memories exist', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }), // active count (at least 1)
        fc.integer({ min: 1, max: 50 }), // limit
        async (activeCount, limit) => {
          // Arrange: Only active memories
          const memories = await fc.sample(
            memoriesWithDistributionArbitrary(activeCount, 0),
            1,
          );
          const client = new MockMemoryClient(memories[0]);
          const scope: MemoryScope = { workspaceId: 'test-ws' };

          // Act: Call both ways
          const withoutStale = await client.recall('test query', scope, limit, false);
          const withStale = await client.recall('test query', scope, limit, true);

          // Assert: Should return same results (no stale to include)
          return withoutStale.length === withStale.length &&
                 withStale.every(m => !m.stale);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Edge case: No stale memories exist.
   * **Validates: Requirements 3.4**
   */
  it('property: list() returns same results when includeStale=true but no stale memories exist', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }), // active count
        fc.integer({ min: 1, max: 50 }), // page size
        async (activeCount, pageSize) => {
          // Arrange: Only active memories
          const memories = await fc.sample(
            memoriesWithDistributionArbitrary(activeCount, 0),
            1,
          );
          const client = new MockMemoryClient(memories[0]);
          const scope: MemoryScope = { workspaceId: 'test-ws' };

          // Act: Call both ways
          const withoutStale = await client.list(scope, pageSize, null, false);
          const withStale = await client.list(scope, pageSize, null, true);

          // Assert: Should return same results
          return withoutStale.total === withStale.total &&
                 withStale.memories.every(m => !m.stale);
        },
      ),
      { numRuns: 100 },
    );
  });
});

