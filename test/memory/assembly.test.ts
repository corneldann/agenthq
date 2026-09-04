// Feature: phase-6.3-context-assembly
// Unit tests for assembleContext, ReadOnlyMemoryClient, and token counting.

import { describe, it, expect, spyOn } from 'bun:test';
import {
  assembleContext,
  ReadOnlyMemoryClient,
  type MemoryAssemblyConfig,
  type MemoryFate,
} from '../../src/memory/assembly.ts';
import type { IMemoryClient, Memory, MemoryScope } from '../../src/memory/types.ts';
import type { Job } from '../../src/types.ts';
import { MemoryClientError } from '../../src/memory/errors.ts';
import { extractMarkersFromOutput, isValidFact } from '../../src/routes/jobs.ts';
import type { DbAdapter } from '../../src/db/adapter.ts';
import { GENERIC_REJECT_PATTERNS } from '../../src/memory/extraction.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'test-job-id',
    name: 'test-job',
    jobChain: 'test-chain',
    sessionChainId: 'test-session',
    timestamp: new Date().toISOString(),
    type: 'test-type',
    agent: 'test-agent',
    status: 'done',
    lines: 0,
    lastLine: '',
    hasLog: false,
    logError: false,
    mdFile: '',
    logFile: '',
    agentDone: '',
    sizeBytes: 0,
    workspaceId: 'test-workspace',
    ...overrides,
  };
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem-' + Math.random().toString(36).slice(2),
    text: 'test memory fact',
    scope: { workspaceId: 'test-workspace' },
    qualityScore: 0.9,
    createdAt: new Date().toISOString(),
    lastRetrievedAt: new Date().toISOString(),
    retrievalCount: 0,
    tier: 'hot',
    embeddingStatus: 'ready',
    stale: false,
    superseded: false,
    ...overrides,
  };
}

class FakeMemoryClient implements IMemoryClient {
  #memories: Memory[];

  constructor(memories: Memory[] = []) {
    this.#memories = memories;
  }

  async recall(_query: string, _scope: MemoryScope, _limit: number): Promise<Memory[]> {
    return this.#memories;
  }

  async reflect(_topic: string, _scope: MemoryScope): Promise<string | null> {
    return null;
  }

  async retain(_text: string, _scope: MemoryScope): Promise<string> {
    return 'fake-id';
  }

  async delete(_id: string): Promise<void> {
    return undefined;
  }

  async list(_scope: MemoryScope, _pageSize: number, _cursor: string | null) {
    return { memories: [], nextCursor: null, total: 0 };
  }

  async get(_id: string): Promise<Memory | null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// assembleContext tests
// ---------------------------------------------------------------------------

describe('assembleContext', () => {
  it('should return empty string when client.recall returns empty array', async () => {
    // Arrange
    const job = makeJob();
    const client = new FakeMemoryClient([]);
    const config: MemoryAssemblyConfig = { candidateLimit: 10, tokenBudget: 1000 };

    // Act
    const result = await assembleContext(job, client, config);

    // Assert
    expect(result).toBe('');
  });

  it('should return empty string when single candidate exceeds token budget', async () => {
    // Arrange
    const job = makeJob();
    const longText = 'a'.repeat(500); // ~125 tokens for the line
    const client = new FakeMemoryClient([makeMemory({ text: longText })]);
    const config: MemoryAssemblyConfig = { candidateLimit: 10, tokenBudget: 50 }; // Too small

    // Act
    const result = await assembleContext(job, client, config);

    // Assert
    expect(result).toBe('');
  });

  it('should include memories in descending relevance order', async () => {
    // Arrange
    const job = makeJob();
    const memories = [
      makeMemory({ text: 'first memory' }),
      makeMemory({ text: 'second memory' }),
      makeMemory({ text: 'third memory' }),
    ];
    const client = new FakeMemoryClient(memories);
    const config: MemoryAssemblyConfig = { candidateLimit: 10, tokenBudget: 1000 };

    // Act
    const result = await assembleContext(job, client, config);

    // Assert
    expect(result).toContain('## Relevant Past Context');
    expect(result).toContain('- first memory');
    expect(result).toContain('- second memory');
    expect(result).toContain('- third memory');
    // Check order
    const firstIndex = result.indexOf('first memory');
    const secondIndex = result.indexOf('second memory');
    const thirdIndex = result.indexOf('third memory');
    expect(firstIndex).toBeLessThan(secondIndex);
    expect(secondIndex).toBeLessThan(thirdIndex);
  });

  it('should format output with no trailing newline on final bullet', async () => {
    // Arrange
    const job = makeJob();
    const memories = [makeMemory({ text: 'single fact' })];
    const client = new FakeMemoryClient(memories);
    const config: MemoryAssemblyConfig = { candidateLimit: 10, tokenBudget: 1000 };

    // Act
    const result = await assembleContext(job, client, config);

    // Assert
    expect(result).toBe('## Relevant Past Context\n- single fact');
    expect(result.endsWith('\n')).toBe(false);
  });

  it('should drop memories that exceed remaining budget', async () => {
    // Arrange
    const job = makeJob();
    const memories = [
      makeMemory({ text: 'short' }), // fits
      makeMemory({ text: 'a'.repeat(400) }), // too large, should be dropped
    ];
    const client = new FakeMemoryClient(memories);
    const config: MemoryAssemblyConfig = { candidateLimit: 10, tokenBudget: 100 };

    // Act
    const result = await assembleContext(job, client, config);

    // Assert
    expect(result).toContain('- short');
    expect(result).not.toContain('a'.repeat(400));
  });

  it('should call collector with included fate for memories within budget', async () => {
    // Arrange
    const job = makeJob();
    const memory = makeMemory({ text: 'fits budget' });
    const client = new FakeMemoryClient([memory]);
    const config: MemoryAssemblyConfig = { candidateLimit: 10, tokenBudget: 1000 };
    const collected: Array<{ memory: Memory; fate: MemoryFate }> = [];
    const collector = (m: Memory, f: MemoryFate) => collected.push({ memory: m, fate: f });

    // Act
    await assembleContext(job, client, config, collector);

    // Assert
    expect(collected).toHaveLength(1);
    expect(collected[0].memory.text).toBe('fits budget');
    expect(collected[0].fate).toBe('included');
  });

  it('should call collector with dropped fate for memories over budget', async () => {
    // Arrange
    const job = makeJob();
    const memory = makeMemory({ text: 'a'.repeat(500) });
    const client = new FakeMemoryClient([memory]);
    const config: MemoryAssemblyConfig = { candidateLimit: 10, tokenBudget: 50 };
    const collected: Array<{ memory: Memory; fate: MemoryFate }> = [];
    const collector = (m: Memory, f: MemoryFate) => collected.push({ memory: m, fate: f });

    // Act
    await assembleContext(job, client, config, collector);

    // Assert
    expect(collected).toHaveLength(1);
    expect(collected[0].fate).toBe('dropped');
  });

  it('should not call collector when undefined', async () => {
    // Arrange
    const job = makeJob();
    const client = new FakeMemoryClient([makeMemory({ text: 'test' })]);
    const config: MemoryAssemblyConfig = { candidateLimit: 10, tokenBudget: 1000 };

    // Act & Assert — should not throw
    const result = await assembleContext(job, client, config, undefined);
    expect(result).toContain('- test');
  });

  it('should count heading tokens before iterating candidates', async () => {
    // Arrange
    const job = makeJob();
    const heading = '## Relevant Past Context\n';
    const headingTokens = Math.ceil(heading.length / 4); // ~7 tokens
    const memory = makeMemory({ text: 'x'.repeat(40) }); // ~12 tokens for "- xxx...\n"
    const client = new FakeMemoryClient([memory]);
    // Budget exactly = heading + line tokens
    const config: MemoryAssemblyConfig = {
      candidateLimit: 10,
      tokenBudget: headingTokens + 12,
    };

    // Act
    const result = await assembleContext(job, client, config);

    // Assert — should fit exactly
    expect(result).toContain('## Relevant Past Context');
    expect(result).toContain('- ' + 'x'.repeat(40));
  });
});

// ---------------------------------------------------------------------------
// ReadOnlyMemoryClient tests
// ---------------------------------------------------------------------------

describe('ReadOnlyMemoryClient', () => {
  it('should forward recall to inner client', async () => {
    // Arrange
    const memory = makeMemory({ text: 'test fact' });
    const inner = new FakeMemoryClient([memory]);
    const readOnly = new ReadOnlyMemoryClient(inner);

    // Act
    const result = await readOnly.recall('query', { workspaceId: 'ws' }, 10);

    // Assert
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('test fact');
  });

  it('should forward reflect to inner client', async () => {
    // Arrange
    const inner = new FakeMemoryClient([]);
    const readOnly = new ReadOnlyMemoryClient(inner);

    // Act
    const result = await readOnly.reflect('topic', { workspaceId: 'ws' });

    // Assert
    expect(result).toBeNull();
  });

  it('should reject retain with MemoryClientError', async () => {
    // Arrange
    const inner = new FakeMemoryClient([]);
    const readOnly = new ReadOnlyMemoryClient(inner);

    // Act & Assert
    await expect(readOnly.retain('fact', { workspaceId: 'ws' })).rejects.toThrow(
      MemoryClientError,
    );
    await expect(readOnly.retain('fact', { workspaceId: 'ws' })).rejects.toThrow(
      'retain is not permitted',
    );
  });

  it('should reject delete with MemoryClientError', async () => {
    // Arrange
    const inner = new FakeMemoryClient([]);
    const readOnly = new ReadOnlyMemoryClient(inner);

    // Act & Assert
    await expect(readOnly.delete('mem-123')).rejects.toThrow(MemoryClientError);
    await expect(readOnly.delete('mem-123')).rejects.toThrow('delete is not permitted');
  });
});

// ---------------------------------------------------------------------------
// MEMORY marker extraction and validation tests
// ---------------------------------------------------------------------------

/**
 * NOTE: Tests in the 'MEMORY marker extraction and validation' section require
 * MEMORY_EXTRACTION_ENABLED=true to be set in the environment.
 * Run with: MEMORY_EXTRACTION_ENABLED=true bun test test/memory/assembly.test.ts
 */
describe('MEMORY marker extraction and validation', () => {
  // Helper to create a fake DbAdapter that tracks execute calls
  class FakeDbAdapter implements DbAdapter {
    executeCalls: Array<{ sql: string; params: unknown[] }> = [];

    async execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }> {
      this.executeCalls.push({ sql, params: params || [] });
      return { rowsAffected: 1 };
    }

    async query<T>(_sql: string, _params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
      return { rows: [], rowCount: 0 };
    }

    async transaction(_fn: (adapter: DbAdapter) => Promise<void>): Promise<void> {
      return undefined;
    }

    async close(): Promise<void> {
      return undefined;
    }
  }

  it('should log console.debug when memories are dropped over budget', async () => {
    // Arrange
    const job = makeJob();
    const longText = 'a'.repeat(400); // ~100 tokens
    const client = new FakeMemoryClient([
      makeMemory({ text: 'short' }), // fits
      makeMemory({ text: longText }), // dropped
    ]);
    const config: MemoryAssemblyConfig = { candidateLimit: 10, tokenBudget: 80 };

    // Spy on console.debug using spyOn from bun:test
    const debugSpy = spyOn(console, 'debug');

    // Act
    await assembleContext(job, client, config);

    // Assert
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropped 1 memories over token budget'),
    );

    // Cleanup
    debugSpy.mockRestore();
  });

  it('should reject facts shorter than 20 characters via extractMarkersFromOutput', async () => {
    // Arrange
    const job = makeJob();
    const output = 'MEMORY: short fact\n'; // 11 chars after trimming
    const client = new FakeMemoryClient([]);
    const db = new FakeDbAdapter();
    let retainCalled = false;

    // Override retain to track calls
    client.retain = async (_text: string, _scope: any) => {
      retainCalled = true;
      return 'fake-id';
    };

    // Act
    await extractMarkersFromOutput(output, job, client, db);

    // Assert — retain should NOT be called for invalid facts
    expect(retainCalled).toBe(false);
  });

  it('should reject facts longer than 500 characters via extractMarkersFromOutput', async () => {
    // Arrange
    const job = makeJob();
    const longFact = 'a'.repeat(501);
    const output = `MEMORY: ${longFact}\n`;
    const client = new FakeMemoryClient([]);
    const db = new FakeDbAdapter();
    let retainCalled = false;

    // Override retain to track calls
    client.retain = async (_text: string, _scope: any) => {
      retainCalled = true;
      return 'fake-id';
    };

    // Act
    await extractMarkersFromOutput(output, job, client, db);

    // Assert — retain should NOT be called for invalid facts
    expect(retainCalled).toBe(false);
  });

  it('should reject facts matching GENERIC_REJECT_PATTERNS via extractMarkersFromOutput', async () => {
    // Arrange
    const job = makeJob();
    // Use a pattern that matches GENERIC_REJECT_PATTERNS: /the system has \w+/i
    const output = 'MEMORY: the system has multiple components running\n';
    const client = new FakeMemoryClient([]);
    const db = new FakeDbAdapter();
    let retainCalled = false;

    // Override retain to track calls
    client.retain = async (_text: string, _scope: any) => {
      retainCalled = true;
      return 'fake-id';
    };

    // Act
    await extractMarkersFromOutput(output, job, client, db);

    // Assert — retain should NOT be called for facts matching reject patterns
    expect(retainCalled).toBe(false);
  });

  it('should match MEMORY marker with case variations (memory:, MEMORY:, Memory:)', async () => {
    // Arrange
    const job = makeJob();
    const output = `memory: first valid fact here okay
MEMORY: second valid fact here good
Memory: third valid fact here fine
`;
    const client = new FakeMemoryClient([]);
    const db = new FakeDbAdapter();
    const retainedFacts: string[] = [];

    // Override retain to track calls
    client.retain = async (text: string, _scope: any) => {
      retainedFacts.push(text);
      return `fake-id-${retainedFacts.length}`;
    };

    // Act
    await extractMarkersFromOutput(output, job, client, db);

    // Assert — all three case variations should be matched
    expect(retainedFacts).toHaveLength(3);
    expect(retainedFacts[0]).toBe('first valid fact here okay');
    expect(retainedFacts[1]).toBe('second valid fact here good');
    expect(retainedFacts[2]).toBe('third valid fact here fine');
  });

  it('should not match lines without leading MEMORY: prefix', async () => {
    // Arrange
    const job = makeJob();
    const output = `Some text before
This is a MEMORY: marker in the middle of the line
MEMORY: valid fact at the start
  MEMORY: indented will not match
Another line with MEMORY: embedded
`;
    const client = new FakeMemoryClient([]);
    const db = new FakeDbAdapter();
    const retainedFacts: string[] = [];

    // Override retain to track calls
    client.retain = async (text: string, _scope: any) => {
      retainedFacts.push(text);
      return `fake-id-${retainedFacts.length}`;
    };

    // Act
    await extractMarkersFromOutput(output, job, client, db);

    // Assert — only the line starting with MEMORY: should match
    expect(retainedFacts).toHaveLength(1);
    expect(retainedFacts[0]).toBe('valid fact at the start');
  });
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

import fc from 'fast-check';

describe('Property-based tests', () => {
  // Feature: phase-6.3-context-assembly, Property 1: Token Budget Invariant
  it('property: token budget is never exceeded regardless of input', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.string(),
            text: fc.string({ minLength: 1, maxLength: 600 }),
            scope: fc.record({
              workspaceId: fc.string(),
            }),
            qualityScore: fc.double({ min: 0, max: 1 }),
            createdAt: fc.string().map(() => new Date().toISOString()),
            lastRetrievedAt: fc.string().map(() => new Date().toISOString()),
            retrievalCount: fc.integer({ min: 0, max: 1000 }),
            tier: fc.constantFrom('hot' as const, 'warm' as const, 'cold' as const),
            embeddingStatus: fc.constantFrom('pending' as const, 'ready' as const, 'failed' as const),
            stale: fc.boolean(),
            superseded: fc.boolean(),
          }),
          { maxLength: 50 },
        ),
        fc.integer({ min: 100, max: 4000 }),
        async (memories, tokenBudget) => {
          // Arrange
          const job = makeJob();
          const client = new FakeMemoryClient(memories);
          const config: MemoryAssemblyConfig = { candidateLimit: 100, tokenBudget };

          // Act
          const result = await assembleContext(job, client, config);

          // Assert
          const actualTokens = Math.ceil(result.length / 4);
          return actualTokens <= tokenBudget;
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: phase-6.3-context-assembly, Property 2: Empty-String Zero Value
  // **Validates: Requirements 1.5, 1.6**
  it('property: returns empty string or proper format when all memories exceed budget', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.string(),
            text: fc.string({ minLength: 1, maxLength: 300 }),
            scope: fc.record({
              workspaceId: fc.string(),
            }),
            qualityScore: fc.double({ min: 0, max: 1 }),
            createdAt: fc.string().map(() => new Date().toISOString()),
            lastRetrievedAt: fc.string().map(() => new Date().toISOString()),
            retrievalCount: fc.integer({ min: 0, max: 1000 }),
            tier: fc.constantFrom('hot' as const, 'warm' as const, 'cold' as const),
            embeddingStatus: fc.constantFrom('pending' as const, 'ready' as const, 'failed' as const),
            stale: fc.boolean(),
            superseded: fc.boolean(),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        fc.integer({ min: 100, max: 500 }),
        async (memories, tokenBudget) => {
          // Arrange
          const job = makeJob();
          // Generate memories where each text individually exceeds budget
          const oversizedMemories = memories.map((m) => {
            const minCharsNeeded = tokenBudget * 4 + 1;
            const text = 'a'.repeat(minCharsNeeded);
            return makeMemory({ ...m, text });
          });
          const client = new FakeMemoryClient(oversizedMemories);
          const config: MemoryAssemblyConfig = { candidateLimit: 100, tokenBudget };

          // Act
          const result = await assembleContext(job, client, config);

          // Assert — result is empty string OR starts with proper format
          return result === '' || result.startsWith('## Relevant Past Context\n- ');
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: phase-6.3-context-assembly, Property 3: Marker Validation Idempotence
  // **Validates: Requirements 3.2, 3.7**
  it('property: isValidFact returns true for all strings in [20, 500] chars without reject-pattern matches', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 20, maxLength: 500 }).filter((s) => {
          // Filter out strings that match any GENERIC_REJECT_PATTERNS
          for (const pattern of GENERIC_REJECT_PATTERNS) {
            if (pattern.test(s)) {
              return false;
            }
          }
          return true;
        }),
        async (fact) => {
          // Act
          const result = isValidFact(fact);

          // Assert — all generated strings should be valid
          // (they're already in [20, 500] and don't match reject patterns)
          return result === true;
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: phase-6.3-context-assembly, Property 5: Format Consistency
  // **Validates: Requirements 1.5**
  it('property: non-empty results have consistent format with no trailing newline', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.string(),
            text: fc.string({ minLength: 1, maxLength: 80 }),
            scope: fc.record({
              workspaceId: fc.string(),
            }),
            qualityScore: fc.double({ min: 0, max: 1 }),
            createdAt: fc.string().map(() => new Date().toISOString()),
            lastRetrievedAt: fc.string().map(() => new Date().toISOString()),
            retrievalCount: fc.integer({ min: 0, max: 1000 }),
            tier: fc.constantFrom('hot' as const, 'warm' as const, 'cold' as const),
            embeddingStatus: fc.constantFrom('pending' as const, 'ready' as const, 'failed' as const),
            stale: fc.boolean(),
            superseded: fc.boolean(),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        async (memories) => {
          // Arrange
          const job = makeJob();
          const client = new FakeMemoryClient(memories);
          const config: MemoryAssemblyConfig = { candidateLimit: 100, tokenBudget: 4000 };

          // Act
          const result = await assembleContext(job, client, config);

          // Assert
          if (result === '') {
            return true; // Empty result is valid
          }

          const lines = result.split('\n');

          // First line must be the heading
          if (lines[0] !== '## Relevant Past Context') {
            return false;
          }

          // Every subsequent line must start with "- "
          for (let i = 1; i < lines.length; i++) {
            if (!lines[i].startsWith('- ')) {
              return false;
            }
          }

          // Result must not end with a newline
          if (result.endsWith('\n')) {
            return false;
          }

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
