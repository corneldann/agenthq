/**
 * Unit tests for the memory route — GET /api/memory/circuit-breaker.
 *
 * Tests both the MEMORY_ENABLED=false (disabled) and MEMORY_ENABLED=true
 * (enabled) branches of the route handler without starting a real Bun server.
 *
 * Strategy:
 *  - The route reads MEMORY_ENABLED as a module-level import from constants.ts.
 *    mock.module() is called inside beforeAll() so that the mock is registered
 *    before each describe group's dynamic import occurs.  Bun invalidates the
 *    module cache on each mock.module() call, ensuring each dynamic import
 *    receives the correct MEMORY_ENABLED value.
 *  - The MemoryCircuitBreaker is replaced by a typed structural fake that
 *    exposes a controllable getMetrics() response.
 *
 * Requirements: 5.7
 */

import { describe, it, expect, mock, beforeAll } from 'bun:test';
import { createRouter } from '../../src/router.ts';
import type { Router } from '../../src/router.ts';
import type { CircuitBreakerMetrics } from '../../src/memory/types.ts';
import type { MemoryCircuitBreaker } from '../../src/memory/circuit-breaker.ts';

// ---------------------------------------------------------------------------
// Helper: dispatch a request through the router without a real server
// ---------------------------------------------------------------------------

async function dispatch(router: Router, url: string): Promise<Response> {
  const req = new Request(`http://localhost${url}`);
  const match = router.match(req);
  if (match === null) {
    return new Response(JSON.stringify({ error: 'no route matched' }), {
      status: 404,
    });
  }
  return match.handler(req, match.params);
}

// ---------------------------------------------------------------------------
// Fake circuit breaker — typed structural stub, never hits the network
// ---------------------------------------------------------------------------

function makeFakeCircuitBreaker(metrics: CircuitBreakerMetrics): MemoryCircuitBreaker {
  return {
    getMetrics(): CircuitBreakerMetrics {
      return metrics;
    },
  } as unknown as MemoryCircuitBreaker;
}

// ---------------------------------------------------------------------------
// Shared constants mock factory — provides all exports from constants.ts
// so downstream modules that transitively import constants don't break.
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleMetrics: CircuitBreakerMetrics = {
  state: 'closed',
  consecutiveFailures: 0,
  totalFailures: 2,
  totalSuccesses: 14,
  lastFailureAt: '2025-01-10T08:00:00.000Z',
  lastSuccessAt: '2025-01-10T09:30:00.000Z',
  openedAt: null,
};

const openMetrics: CircuitBreakerMetrics = {
  state: 'open',
  consecutiveFailures: 3,
  totalFailures: 5,
  totalSuccesses: 10,
  lastFailureAt: '2025-01-10T10:00:00.000Z',
  lastSuccessAt: '2025-01-10T09:00:00.000Z',
  openedAt: '2025-01-10T10:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Tests — MEMORY_ENABLED=false (disabled)
//
// mock.module() is called inside beforeAll() so it fires before any test in
// this describe block.  The dynamic import inside each test then receives the
// freshly-mocked module with MEMORY_ENABLED=false.
// ---------------------------------------------------------------------------

describe('GET /api/memory/circuit-breaker — MEMORY_ENABLED=false', () => {
  beforeAll(() => {
    mock.module('../../src/constants.ts', () => makeConstantsMock(false));
  });

  it('should return 200 with { state: "disabled" }', async () => {
    // Arrange — fresh import after the mock above invalidates the cache
    const { register } = await import('../../src/routes/memory.ts');
    const router = createRouter();
    // Pass null: handler must not reach the circuit breaker when disabled
    register(router, null);

    // Act
    const res = await dispatch(router, '/api/memory/circuit-breaker');

    // Assert
    expect(res.status).toBe(200);
    const body = await res.json() as { state: string };
    expect(body).toStrictEqual({ state: 'disabled' });
  });

  it('should set content-type: application/json when disabled', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory.ts');
    const router = createRouter();
    register(router, null);

    // Act
    const res = await dispatch(router, '/api/memory/circuit-breaker');

    // Assert
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

// ---------------------------------------------------------------------------
// Tests — MEMORY_ENABLED=true (enabled)
//
// A second mock.module() call inside beforeAll() re-registers the mock with
// MEMORY_ENABLED=true.  Dynamic imports in each test receive the updated value.
// ---------------------------------------------------------------------------

describe('GET /api/memory/circuit-breaker — MEMORY_ENABLED=true', () => {
  beforeAll(() => {
    mock.module('../../src/constants.ts', () => makeConstantsMock(true));
  });

  it('should return 200 with CircuitBreakerMetrics from getMetrics()', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory.ts');
    const router = createRouter();
    const fakeBreaker = makeFakeCircuitBreaker(sampleMetrics);
    register(router, fakeBreaker);

    // Act
    const res = await dispatch(router, '/api/memory/circuit-breaker');

    // Assert
    expect(res.status).toBe(200);
    const body = await res.json() as CircuitBreakerMetrics;
    expect(body.state).toBe('closed');
    expect(body.consecutiveFailures).toBe(0);
    expect(body.totalFailures).toBe(2);
    expect(body.totalSuccesses).toBe(14);
    expect(body.lastFailureAt).toBe('2025-01-10T08:00:00.000Z');
    expect(body.lastSuccessAt).toBe('2025-01-10T09:30:00.000Z');
    expect(body.openedAt).toBeNull();
  });

  it('should set content-type: application/json when enabled', async () => {
    // Arrange
    const { register } = await import('../../src/routes/memory.ts');
    const router = createRouter();
    const fakeBreaker = makeFakeCircuitBreaker(sampleMetrics);
    register(router, fakeBreaker);

    // Act
    const res = await dispatch(router, '/api/memory/circuit-breaker');

    // Assert
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('should return all required CircuitBreakerMetrics fields when circuit is open', async () => {
    // Arrange — verify the full shape with openedAt set
    const { register } = await import('../../src/routes/memory.ts');
    const router = createRouter();
    const fakeBreaker = makeFakeCircuitBreaker(openMetrics);
    register(router, fakeBreaker);

    // Act
    const res = await dispatch(router, '/api/memory/circuit-breaker');

    // Assert
    expect(res.status).toBe(200);
    const body = await res.json() as CircuitBreakerMetrics;
    expect(body.state).toBe('open');
    expect(body.consecutiveFailures).toBe(3);
    expect(body.totalFailures).toBe(5);
    expect(body.totalSuccesses).toBe(10);
    expect(body.lastFailureAt).toBe('2025-01-10T10:00:00.000Z');
    expect(body.lastSuccessAt).toBe('2025-01-10T09:00:00.000Z');
    expect(body.openedAt).toBe('2025-01-10T10:00:00.000Z');
  });
});
