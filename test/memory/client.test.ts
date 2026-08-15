import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import { createMemoryClient, NoOpMemoryClient } from '../../src/memory/client.ts';
import { MemoryCircuitBreaker } from '../../src/memory/circuit-breaker.ts';
import type { MemoryScope } from '../../src/memory/types.ts';

// ---------------------------------------------------------------------------
// Unit tests — createMemoryClient with enabled: false
// ---------------------------------------------------------------------------

describe('createMemoryClient — disabled (enabled: false)', () => {
  const config = {
    enabled: false,
    baseUrl: 'http://localhost:3100',
    retryPath: '/tmp/test-retry.jsonl',
  };

  it('should return a NoOpMemoryClient instance', () => {
    // Arrange / Act
    const client = createMemoryClient(config);

    // Assert
    expect(client).toBeInstanceOf(NoOpMemoryClient);
  });

  it('should return empty string from retain', async () => {
    // Arrange
    const client = createMemoryClient(config);
    const scope: MemoryScope = { workspaceId: 'ws-test' };

    // Act
    const result = await client.retain('some text', scope);

    // Assert
    expect(result).toBe('');
  });

  it('should return empty array from recall', async () => {
    // Arrange
    const client = createMemoryClient(config);
    const scope: MemoryScope = { workspaceId: 'ws-test' };

    // Act
    const result = await client.recall('query', scope, 10);

    // Assert
    expect(result).toStrictEqual([]);
  });

  it('should return null from reflect', async () => {
    // Arrange
    const client = createMemoryClient(config);
    const scope: MemoryScope = { workspaceId: 'ws-test' };

    // Act
    const result = await client.reflect('topic', scope);

    // Assert
    expect(result).toBeNull();
  });

  it('should return undefined from delete', async () => {
    // Arrange
    const client = createMemoryClient(config);

    // Act
    const result = await client.delete('mem-id');

    // Assert
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unit tests — createMemoryClient with enabled: true
// ---------------------------------------------------------------------------

describe('createMemoryClient — enabled (enabled: true)', () => {
  it('should return a MemoryCircuitBreaker instance', () => {
    // Arrange
    const config = {
      enabled: true,
      baseUrl: 'http://localhost:3100',
      retryPath: '/tmp/test-retry.jsonl',
    };

    // Act
    const client = createMemoryClient(config);

    // Assert
    expect(client).toBeInstanceOf(MemoryCircuitBreaker);
  });
});

// ---------------------------------------------------------------------------
// Property 1: NoOp client returns safe zero-values for any input
//
// Feature: phase-6.1-memory-infrastructure, Property 1: NoOp client returns safe zero-values for any input
// ---------------------------------------------------------------------------

describe('Property 1: NoOpMemoryClient returns safe zero-values for any input', () => {
  it('property: all methods return zero-values and never throw', async () => {
    // Feature: phase-6.1-memory-infrastructure, Property 1: NoOp client returns safe zero-values for any input
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.record({ workspaceId: fc.string() }),
        fc.integer({ min: 0, max: 100 }),
        fc.string(),
        fc.string(),
        async (text, scope, limit, id, topic) => {
          // Arrange
          const client = new NoOpMemoryClient();

          // Act & Assert — retain returns ''
          const retainResult = await client.retain(text, scope);
          expect(retainResult).toBe('');

          // Act & Assert — recall returns []
          const recallResult = await client.recall(text, scope, limit);
          expect(recallResult).toStrictEqual([]);

          // Act & Assert — reflect returns null
          const reflectResult = await client.reflect(topic, scope);
          expect(reflectResult).toBeNull();

          // Act & Assert — delete returns undefined
          const deleteResult = await client.delete(id);
          expect(deleteResult).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});
