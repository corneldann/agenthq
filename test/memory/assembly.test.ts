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
import { extractMarkersFromOutput } from '../../src/routes/jobs.ts';
import type { DbAdapter } from '../../src/db/adapter.ts';

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
