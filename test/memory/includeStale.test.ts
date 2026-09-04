// test/memory/includeStale.test.ts
// Unit tests for includeStale parameter support (Task 2.2, Phase 6.5)
// Requirements: 3.3, 3.4

import { describe, it, expect } from 'bun:test';
import type { Memory, MemoryScope, IMemoryClient } from '../../src/memory/types.js';

// Mock memory client that respects includeStale parameter
class MockMemoryClient implements IMemoryClient {
  #memories: Memory[];

  constructor(memories: Memory[]) {
    this.#memories = memories;
  }

  async retain(_text: string, _scope: MemoryScope): Promise<string> {
    return 'mock-id';
  }

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

describe('includeStale parameter support', () => {
  const activeMemory: Memory = {
    id: 'active-1',
    text: 'Active memory',
    scope: { workspaceId: 'ws-1' },
    qualityScore: 0.8,
    createdAt: '2024-01-01T00:00:00Z',
    lastRetrievedAt: '2024-01-02T00:00:00Z',
    retrievalCount: 5,
    tier: 'hot',
    embeddingStatus: 'ready',
    stale: false,
    superseded: false,
  };

  const staleMemory: Memory = {
    id: 'stale-1',
    text: 'Stale memory',
    scope: { workspaceId: 'ws-1' },
    qualityScore: 0.7,
    createdAt: '2023-01-01T00:00:00Z',
    lastRetrievedAt: '2023-06-01T00:00:00Z',
    retrievalCount: 2,
    tier: 'cold',
    embeddingStatus: 'ready',
    stale: true,
    superseded: false,
  };

  describe('recall', () => {
    it('should exclude stale memories by default', async () => {
      // Arrange
      const client = new MockMemoryClient([activeMemory, staleMemory]);
      const scope: MemoryScope = { workspaceId: 'ws-1' };

      // Act
      const result = await client.recall('test', scope, 10);

      // Assert
      expect(result.length).toBe(1);
      expect(result[0]?.id).toBe('active-1');
      expect(result.every(m => !m.stale)).toBe(true);
    });

    it('should include stale memories when includeStale=true', async () => {
      // Arrange
      const client = new MockMemoryClient([activeMemory, staleMemory]);
      const scope: MemoryScope = { workspaceId: 'ws-1' };

      // Act
      const result = await client.recall('test', scope, 10, true);

      // Assert
      expect(result.length).toBe(2);
      expect(result.some(m => m.stale)).toBe(true);
    });

    it('should exclude stale memories when includeStale=false', async () => {
      // Arrange
      const client = new MockMemoryClient([activeMemory, staleMemory]);
      const scope: MemoryScope = { workspaceId: 'ws-1' };

      // Act
      const result = await client.recall('test', scope, 10, false);

      // Assert
      expect(result.length).toBe(1);
      expect(result[0]?.id).toBe('active-1');
    });
  });

  describe('list', () => {
    it('should exclude stale memories by default', async () => {
      // Arrange
      const client = new MockMemoryClient([activeMemory, staleMemory]);
      const scope: MemoryScope = { workspaceId: 'ws-1' };

      // Act
      const result = await client.list(scope, 10, null);

      // Assert
      expect(result.memories.length).toBe(1);
      expect(result.memories[0]?.id).toBe('active-1');
      expect(result.total).toBe(1);
    });

    it('should include stale memories when includeStale=true', async () => {
      // Arrange
      const client = new MockMemoryClient([activeMemory, staleMemory]);
      const scope: MemoryScope = { workspaceId: 'ws-1' };

      // Act
      const result = await client.list(scope, 10, null, true);

      // Assert
      expect(result.memories.length).toBe(2);
      expect(result.total).toBe(2);
      expect(result.memories.some(m => m.stale)).toBe(true);
    });

    it('should exclude stale memories when includeStale=false', async () => {
      // Arrange
      const client = new MockMemoryClient([activeMemory, staleMemory]);
      const scope: MemoryScope = { workspaceId: 'ws-1' };

      // Act
      const result = await client.list(scope, 10, null, false);

      // Assert
      expect(result.memories.length).toBe(1);
      expect(result.memories[0]?.id).toBe('active-1');
      expect(result.total).toBe(1);
    });
  });
});
