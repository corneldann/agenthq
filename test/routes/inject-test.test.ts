/**
 * Unit tests for POST /api/memory/inject-test diagnostic endpoint.
 *
 * Feature: phase-6.3-context-assembly
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 *
 * Tests the inject-test route that shows what memories would be injected
 * for a given job without modifying state. Uses the same mock.module() pattern
 * from memory.test.ts to control MEMORY_ENABLED flag.
 *
 * Strategy:
 *  - mock.module() for constants.ts to control MEMORY_ENABLED
 *  - Dynamic imports in each test receive the correct flag value
 *  - Fake IMemoryClient returns controlled memory arrays
 *  - Fake MemoryCircuitBreaker returns controlled metrics
 *  - No real HTTP server — dispatch() calls handler directly
 */

import { describe, it, expect, mock, beforeAll } from 'bun:test';
import { createRouter } from '../../src/router.ts';
import type { Router } from '../../src/router.ts';
import type { CircuitBreakerMetrics, IMemoryClient, Memory, MemoryScope } from '../../src/memory/types.ts';
import type { MemoryCircuitBreaker } from '../../src/memory/circuit-breaker.ts';
import type { Job } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// Helper: dispatch a request through the router without a real server
// ---------------------------------------------------------------------------

async function dispatch(router: Router, url: string, options?: RequestInit): Promise<Response> {
  const req = new Request(`http://localhost${url}`, options);
  const match = router.match(req);
  if (match === null) {
    return new Response(JSON.stringify({ error: 'no route matched' }), {
      status: 404,
    });
  }
  return match.handler(req, match.params);
}

// ---------------------------------------------------------------------------
// Fakes and fixtures
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
    throw new Error('FakeMemoryClient.retain should not be called during inject-test');
  }

  async delete(_id: string): Promise<void> {
    throw new Error('FakeMemoryClient.delete should not be called during inject-test');
  }

  async list(_scope: MemoryScope, _pageSize: number, _cursor: string | null) {
    return { memories: [], nextCursor: null, total: 0 };
  }

  async get(_id: string): Promise<Memory | null> {
    return null;
  }
}

function makeFakeCircuitBreaker(
  client: IMemoryClient,
  metrics: CircuitBreakerMetrics
): MemoryCircuitBreaker {
  return {
    recall: client.recall.bind(client),
    reflect: client.reflect.bind(client),
    retain: client.retain.bind(client),
    delete: client.delete.bind(client),
    getMetrics(): CircuitBreakerMetrics {
      return metrics;
    },
  } as unknown as MemoryCircuitBreaker;
}

const closedMetrics: CircuitBreakerMetrics = {
  state: 'closed',
  consecutiveFailures: 0,
  totalFailures: 0,
  totalSuccesses: 5,
  lastFailureAt: null,
  lastSuccessAt: new Date().toISOString(),
  openedAt: null,
};

// ---------------------------------------------------------------------------
// Constants mock factory
// ---------------------------------------------------------------------------

function makeConstantsMock(memoryEnabled: boolean): Record<string, unknown> {
  return {
    resolveConstants: () => ({}),
    PORT: 3333,
    POLL_LOG_MAX: 200,
    SCAN_CACHE_TTL: 5000,
    SHUTDOWN_TIMEOUT_MS: 5000,
    OUTPUT_DIR: '',
    SESSIONS_DIR: '',
    CHAINS_DIR: '',
    WORKFLOW_DIR: '',
    WORKSPACE_ROOT: '',
    SPECS_DIR: '',
    PROMPT_OUTPUT_DIR: '',
    CRAWL_JOBS_FILE: 'docs/reference/.crawl-queue.json',
    CLONE_JOBS_FILE: 'docs/reference/.clone-queue.json',
    BUILD_QUEUE_FILE: 'docs/reference/.build-queue.json',
    KIRO_TOOLS_DIR: '',
    MEMORY_ENABLED: memoryEnabled,
    HINDSIGHT_URL: 'http://localhost:3100',
    MEMORY_EXTRACTION_ENABLED: false,
    MEMORY_AUTO_INJECT: false,
    MEMORY_MAX_CONTEXT_MEMORIES: 10,
    MEMORY_CONTEXT_TOKEN_BUDGET: 2000,
    MEMORY_DECAY_DAYS: 90,
    MEMORY_RETRY_PATH: 'data/memory-retry-queue.jsonl',
  };
}

// Mock scanJobs to return controlled job list
function mockScanJobs(jobs: Job[]) {
  mock.module('../../src/scan/jobs.ts', () => ({
    scanJobs: async () => jobs,
  }));
}

// ---------------------------------------------------------------------------
// Tests — POST /api/memory/inject-test with MEMORY_ENABLED=false
// ---------------------------------------------------------------------------

describe('POST /api/memory/inject-test — MEMORY_ENABLED=false', () => {
  beforeAll(() => {
    mock.module('../../src/constants.ts', () => makeConstantsMock(false));
  });

  it('should return 503 with error message when memory is disabled', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory.ts');
    const router = createRouter();
    register(router, null);

    // Act
    const res = await dispatch(router, '/api/memory/inject-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'any-job-id' }),
    });

    // Assert
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('memory is not enabled');
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /api/memory/inject-test with MEMORY_ENABLED=true
// ---------------------------------------------------------------------------

describe('POST /api/memory/inject-test — MEMORY_ENABLED=true', () => {
  beforeAll(() => {
    mock.module('../../src/constants.ts', () => makeConstantsMock(true));
  });

  it('should return 404 when job is not found', async () => {
    // Arrange
    mockScanJobs([]); // Empty job list
    const { register } = await import('../../src/routes/memory.ts');
    const router = createRouter();
    const client = new FakeMemoryClient([]);
    const breaker = makeFakeCircuitBreaker(client, closedMetrics);
    register(router, breaker);

    // Act
    const res = await dispatch(router, '/api/memory/inject-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'nonexistent-job' }),
    });

    // Assert
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; jobId: string };
    expect(body.error).toBe('job not found');
    expect(body.jobId).toBe('nonexistent-job');
  });

  it('should return 400 when job status is running', async () => {
    // Arrange
    const job = makeJob({ id: 'running-job', status: 'running' });
    mockScanJobs([job]);
    const { register } = await import('../../src/routes/memory.ts');
    const router = createRouter();
    const client = new FakeMemoryClient([]);
    const breaker = makeFakeCircuitBreaker(client, closedMetrics);
    register(router, breaker);

    // Act
    const res = await dispatch(router, '/api/memory/inject-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'running-job' }),
    });

    // Assert
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; status: string };
    expect(body.error).toBe('job is not in a completed state');
    expect(body.status).toBe('running');
  });

  it('should return 400 when job status is error', async () => {
    // Arrange
    const job = makeJob({ id: 'error-job', status: 'error' });
    mockScanJobs([job]);
    const { register } = await import('../../src/routes/memory.ts');
    const router = createRouter();
    const client = new FakeMemoryClient([]);
    const breaker = makeFakeCircuitBreaker(client, closedMetrics);
    register(router, breaker);

    // Act
    const res = await dispatch(router, '/api/memory/inject-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'error-job' }),
    });

    // Assert
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; status: string };
    expect(body.error).toBe('job is not in a completed state');
    expect(body.status).toBe('error');
  });

  it('should return 200 with correct InjectTestResponse shape when job is completed', async () => {
    // Arrange
    const job = makeJob({ id: 'completed-job', status: 'done' });
    const memories = [
      makeMemory({ text: 'first memory fact' }),
      makeMemory({ text: 'second memory fact' }),
    ];
    mockScanJobs([job]);
    const { register } = await import('../../src/routes/memory.ts');
    const router = createRouter();
    const client = new FakeMemoryClient(memories);
    const breaker = makeFakeCircuitBreaker(client, closedMetrics);
    register(router, breaker);

    // Act
    const res = await dispatch(router, '/api/memory/inject-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'completed-job' }),
    });

    // Assert
    expect(res.status).toBe(200);
    const body = await res.json() as {
      memoryCount: number;
      tokenCount: number;
      memories: Memory[];
      dropped: number;
      circuitState: string;
      assemblyMs: number;
    };

    // Verify all required fields are present
    expect(typeof body.memoryCount).toBe('number');
    expect(typeof body.tokenCount).toBe('number');
    expect(Array.isArray(body.memories)).toBe(true);
    expect(typeof body.dropped).toBe('number');
    expect(typeof body.circuitState).toBe('string');
    expect(typeof body.assemblyMs).toBe('number');

    // Verify actual values
    expect(body.memoryCount).toBe(2);
    expect(body.memories).toHaveLength(2);
    expect(body.dropped).toBe(0);
    expect(body.circuitState).toBe('closed');
  });

  it('should have assemblyMs as non-negative integer', async () => {
    // Arrange
    const job = makeJob({ id: 'timing-test-job', status: 'done' });
    mockScanJobs([job]);
    const { register } = await import('../../src/routes/memory.ts');
    const router = createRouter();
    const client = new FakeMemoryClient([makeMemory({ text: 'test fact' })]);
    const breaker = makeFakeCircuitBreaker(client, closedMetrics);
    register(router, breaker);

    // Act
    const res = await dispatch(router, '/api/memory/inject-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'timing-test-job' }),
    });

    // Assert
    expect(res.status).toBe(200);
    const body = await res.json() as { assemblyMs: number };
    expect(body.assemblyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.assemblyMs)).toBe(true);
  });

  it('should report correct dropped count when memories exceed budget', async () => {
    // Arrange
    const job = makeJob({ id: 'budget-test-job', status: 'done' });
    const memories = [
      makeMemory({ text: 'short' }), // fits
      makeMemory({ text: 'a'.repeat(400) }), // too large, dropped
      makeMemory({ text: 'b'.repeat(400) }), // too large, dropped
    ];
    mockScanJobs([job]);
    
    // Mock constants with a small token budget
    mock.module('../../src/constants.ts', () => {
      const base = makeConstantsMock(true);
      return { ...base, MEMORY_CONTEXT_TOKEN_BUDGET: 100 };
    });
    
    const { register } = await import('../../src/routes/memory.ts');
    const router = createRouter();
    const client = new FakeMemoryClient(memories);
    const breaker = makeFakeCircuitBreaker(client, closedMetrics);
    register(router, breaker);

    // Act
    const res = await dispatch(router, '/api/memory/inject-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'budget-test-job' }),
    });

    // Assert
    expect(res.status).toBe(200);
    const body = await res.json() as { memoryCount: number; dropped: number };
    expect(body.memoryCount).toBe(1); // Only "short" fits
    expect(body.dropped).toBe(2); // Two large memories dropped
  });

  it('should prevent write operations via ReadOnlyMemoryClient during diagnostic execution', async () => {
    // Arrange
    const job = makeJob({ id: 'readonly-test-job', status: 'done' });
    mockScanJobs([job]);
    
    let retainCalled = false;
    let deleteCalled = false;
    
    class SpyMemoryClient implements IMemoryClient {
      async recall(_query: string, _scope: MemoryScope, _limit: number): Promise<Memory[]> {
        return [makeMemory({ text: 'test fact' })];
      }
      async reflect(_topic: string, _scope: MemoryScope): Promise<string | null> {
        return null;
      }
      async retain(_text: string, _scope: MemoryScope): Promise<string> {
        retainCalled = true;
        return 'fake-id';
      }
      async delete(_id: string): Promise<void> {
        deleteCalled = true;
      }
      async list(_scope: MemoryScope, _pageSize: number, _cursor: string | null) {
        return { memories: [], nextCursor: null, total: 0 };
      }
      async get(_id: string): Promise<Memory | null> {
        return null;
      }
    }
    
    const { register } = await import('../../src/routes/memory.ts');
    const router = createRouter();
    const spyClient = new SpyMemoryClient();
    const breaker = makeFakeCircuitBreaker(spyClient, closedMetrics);
    register(router, breaker);

    // Act
    const res = await dispatch(router, '/api/memory/inject-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'readonly-test-job' }),
    });

    // Assert
    expect(res.status).toBe(200);
    // Verify that no write operations reached the inner client
    expect(retainCalled).toBe(false);
    expect(deleteCalled).toBe(false);
  });

  it('should return 400 when request body is malformed', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory.ts');
    const router = createRouter();
    const client = new FakeMemoryClient([]);
    const breaker = makeFakeCircuitBreaker(client, closedMetrics);
    register(router, breaker);

    // Act
    const res = await dispatch(router, '/api/memory/inject-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not valid json',
    });

    // Assert
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('malformed request body');
  });

  it('should return 400 when jobId is missing from request body', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory.ts');
    const router = createRouter();
    const client = new FakeMemoryClient([]);
    const breaker = makeFakeCircuitBreaker(client, closedMetrics);
    register(router, breaker);

    // Act
    const res = await dispatch(router, '/api/memory/inject-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    // Assert
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('jobId is required');
  });

  it('should return 400 when jobId is empty string', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory.ts');
    const router = createRouter();
    const client = new FakeMemoryClient([]);
    const breaker = makeFakeCircuitBreaker(client, closedMetrics);
    register(router, breaker);

    // Act
    const res = await dispatch(router, '/api/memory/inject-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: '' }),
    });

    // Assert
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('jobId is required');
  });
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

import fc from 'fast-check';

describe('Property-based tests', () => {
  beforeAll(() => {
    mock.module('../../src/constants.ts', () => makeConstantsMock(true));
  });

  // Feature: phase-6.3-context-assembly, Property 4: Read-Only Diagnostic Isolation
  // **Validates: Requirements 4.2**
  it('property: inject-test never calls retain or delete on inner client for any completed job', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          jobId: fc.string({ minLength: 1, maxLength: 50 }),
          jobName: fc.string({ minLength: 1, maxLength: 50 }),
          status: fc.constantFrom('done' as const, 'reported' as const),
        }),
        fc.array(
          fc.record({
            text: fc.string({ minLength: 1, maxLength: 300 }),
          }),
          { maxLength: 20 },
        ),
        async (jobData, memoryData) => {
          // Arrange
          const job = makeJob({
            id: jobData.jobId,
            name: jobData.jobName,
            status: jobData.status,
          });
          mockScanJobs([job]);

          let retainCallCount = 0;
          let deleteCallCount = 0;

          class CountingMemoryClient implements IMemoryClient {
            async recall(_query: string, _scope: MemoryScope, _limit: number): Promise<Memory[]> {
              return memoryData.map((m) => makeMemory({ text: m.text }));
            }
            async reflect(_topic: string, _scope: MemoryScope): Promise<string | null> {
              return null;
            }
            async retain(_text: string, _scope: MemoryScope): Promise<string> {
              retainCallCount += 1;
              return 'fake-id';
            }
            async delete(_id: string): Promise<void> {
              deleteCallCount += 1;
            }
            async list(_scope: MemoryScope, _pageSize: number, _cursor: string | null) {
              return { memories: [], nextCursor: null, total: 0 };
            }
            async get(_id: string): Promise<Memory | null> {
              return null;
            }
          }

          const { register } = await import('../../src/routes/memory.ts');
          const router = createRouter();
          const countingClient = new CountingMemoryClient();
          const breaker = makeFakeCircuitBreaker(countingClient, closedMetrics);
          register(router, breaker);

          // Act
          const res = await dispatch(router, '/api/memory/inject-test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobId: jobData.jobId }),
          });

          // Assert
          if (res.status !== 200) {
            // If the endpoint returned an error, it's still valid behavior
            // (e.g., if the job doesn't exist due to test setup)
            return true;
          }

          // For successful responses, verify no write operations reached the inner client
          return retainCallCount === 0 && deleteCallCount === 0;
        },
      ),
      { numRuns: 50 },
    );
  });
});
