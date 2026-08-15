import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import * as fc from 'fast-check';
import { MemoryCircuitBreaker } from '../../src/memory/circuit-breaker.ts';
import {
  MemoryClientError,
  MemoryServiceError,
  MemoryTimeoutError,
} from '../../src/memory/errors.ts';
import {
  CircuitState,
  type IMemoryClient,
  type Memory,
  type MemoryScope,
  type RetryQueueEntry,
} from '../../src/memory/types.ts';

// ---------------------------------------------------------------------------
// FakeMemoryClient — typed test double, never hits the network
// ---------------------------------------------------------------------------

class FakeMemoryClient implements IMemoryClient {
  calls = 0;
  shouldFail = false;
  failWith: Error | null = null;

  reset(): void {
    this.calls = 0;
    this.shouldFail = false;
    this.failWith = null;
  }

  retain(_text: string, _scope: MemoryScope): Promise<string> {
    this.calls++;
    if (this.failWith !== null) return Promise.reject(this.failWith);
    if (this.shouldFail) return Promise.reject(new MemoryServiceError('service error', 500));
    return Promise.resolve('mem-id');
  }

  recall(_query: string, _scope: MemoryScope, _limit: number): Promise<Memory[]> {
    this.calls++;
    if (this.failWith !== null) return Promise.reject(this.failWith);
    if (this.shouldFail) return Promise.reject(new MemoryServiceError('service error', 500));
    return Promise.resolve([]);
  }

  reflect(_topic: string, _scope: MemoryScope): Promise<string | null> {
    this.calls++;
    if (this.failWith !== null) return Promise.reject(this.failWith);
    if (this.shouldFail) return Promise.reject(new MemoryServiceError('service error', 500));
    return Promise.resolve('reflection');
  }

  delete(_id: string): Promise<void> {
    this.calls++;
    if (this.failWith !== null) return Promise.reject(this.failWith);
    if (this.shouldFail) return Promise.reject(new MemoryServiceError('service error', 500));
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// FakeRetryQueue — in-memory fake, no disk I/O
// ---------------------------------------------------------------------------

class FakeRetryQueue {
  entries: RetryQueueEntry[] = [];

  enqueue(entry: RetryQueueEntry): void {
    this.entries.push(entry);
  }

  drain(): Promise<number> {
    return Promise.resolve(0);
  }

  size(): number {
    return this.entries.length;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SCOPE: MemoryScope = { workspaceId: 'ws-test' };

type BreakerConfig = {
  inner?: FakeMemoryClient;
  retryQueue?: FakeRetryQueue;
  failureThreshold?: number;
  openTimeoutMs?: number;
};

function makeBreaker(opts: BreakerConfig = {}): {
  breaker: MemoryCircuitBreaker;
  inner: FakeMemoryClient;
  queue: FakeRetryQueue;
} {
  const inner = opts.inner ?? new FakeMemoryClient();
  const queue = opts.retryQueue ?? new FakeRetryQueue();
  const breaker = new MemoryCircuitBreaker({
    inner,
    // FakeRetryQueue is structurally compatible — cast via unknown to satisfy
    // the private-field-typed parameter
    retryQueue: queue as unknown as InstanceType<typeof import('../../src/memory/retry-queue.ts').RetryQueue>,
    failureThreshold: opts.failureThreshold ?? 3,
    openTimeoutMs: opts.openTimeoutMs ?? 30_000,
  });
  return { breaker, inner, queue };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Unit tests — initial state
// ---------------------------------------------------------------------------

describe('MemoryCircuitBreaker — initial state', () => {
  it('should start in closed state', () => {
    const { breaker } = makeBreaker();
    expect(breaker.getMetrics().state).toBe(CircuitState.closed);
  });

  it('should start with zero consecutive failures', () => {
    const { breaker } = makeBreaker();
    expect(breaker.getMetrics().consecutiveFailures).toBe(0);
  });

  it('should start with zero total failures and successes', () => {
    const { breaker } = makeBreaker();
    const m = breaker.getMetrics();
    expect(m.totalFailures).toBe(0);
    expect(m.totalSuccesses).toBe(0);
  });

  it('should start with null timestamp fields', () => {
    const { breaker } = makeBreaker();
    const m = breaker.getMetrics();
    expect(m.lastFailureAt).toBeNull();
    expect(m.lastSuccessAt).toBeNull();
    expect(m.openedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit tests — getMetrics
// ---------------------------------------------------------------------------

describe('MemoryCircuitBreaker — getMetrics', () => {
  it('should return a complete metrics object with all required fields', () => {
    const { breaker } = makeBreaker();
    const m = breaker.getMetrics();
    expect(m).toHaveProperty('state');
    expect(m).toHaveProperty('consecutiveFailures');
    expect(m).toHaveProperty('totalFailures');
    expect(m).toHaveProperty('totalSuccesses');
    expect(m).toHaveProperty('lastFailureAt');
    expect(m).toHaveProperty('lastSuccessAt');
    expect(m).toHaveProperty('openedAt');
  });

  it('should return a snapshot that does not mutate when breaker state changes', async () => {
    const { breaker, inner } = makeBreaker({ failureThreshold: 1 });
    const snapshot = breaker.getMetrics();
    expect(snapshot.state).toBe(CircuitState.closed);

    inner.shouldFail = true;
    await breaker.retain('text', TEST_SCOPE);

    // Previously captured snapshot must not reflect new state
    expect(snapshot.state).toBe(CircuitState.closed);
    // Live metrics now show open
    expect(breaker.getMetrics().state).toBe(CircuitState.open);
  });

  it('should record openedAt timestamp when breaker opens', async () => {
    const { breaker, inner } = makeBreaker({ failureThreshold: 1 });
    inner.shouldFail = true;
    await breaker.retain('text', TEST_SCOPE);

    const m = breaker.getMetrics();
    expect(m.state).toBe(CircuitState.open);
    expect(m.openedAt).not.toBeNull();
    expect(typeof m.openedAt).toBe('string');
  });

  it('should clear openedAt when breaker returns to closed', async () => {
    const { breaker, inner } = makeBreaker({ failureThreshold: 1, openTimeoutMs: 1 });
    inner.shouldFail = true;
    await breaker.retain('text', TEST_SCOPE);
    await delay(20);

    inner.shouldFail = false;
    inner.failWith = null;
    await breaker.retain('text', TEST_SCOPE);

    const m = breaker.getMetrics();
    expect(m.state).toBe(CircuitState.closed);
    expect(m.openedAt).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// Unit tests — closed → open transitions
// ---------------------------------------------------------------------------

describe('MemoryCircuitBreaker — closed → open transition', () => {
  it('should remain closed after fewer than failureThreshold MemoryServiceErrors', async () => {
    const { breaker, inner } = makeBreaker({ failureThreshold: 3 });
    inner.failWith = new MemoryServiceError('svc', 500);
    await breaker.retain('a', TEST_SCOPE);
    await breaker.retain('b', TEST_SCOPE);
    expect(breaker.getMetrics().state).toBe(CircuitState.closed);
    expect(breaker.getMetrics().consecutiveFailures).toBe(2);
  });

  it('should transition to open after exactly failureThreshold MemoryServiceErrors', async () => {
    const { breaker, inner } = makeBreaker({ failureThreshold: 2 });
    inner.failWith = new MemoryServiceError('svc', 500);
    await breaker.retain('a', TEST_SCOPE);
    await breaker.retain('b', TEST_SCOPE);
    expect(breaker.getMetrics().state).toBe(CircuitState.open);
  });

  it('should reset consecutiveFailures to 0 on a success in closed state', async () => {
    const { breaker, inner } = makeBreaker({ failureThreshold: 3 });
    inner.failWith = new MemoryServiceError('svc', 500);
    await breaker.retain('a', TEST_SCOPE);
    inner.failWith = null;
    await breaker.retain('b', TEST_SCOPE);
    expect(breaker.getMetrics().consecutiveFailures).toBe(0);
    expect(breaker.getMetrics().state).toBe(CircuitState.closed);
  });

  it('should enqueue retain payload to RetryQueue when opening', async () => {
    const { breaker, inner, queue } = makeBreaker({ failureThreshold: 1 });
    inner.failWith = new MemoryServiceError('svc', 500);
    await breaker.retain('hello', TEST_SCOPE);
    expect(queue.entries.length).toBe(1);
    expect(queue.entries[0].text).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// Unit tests — open state fallbacks
// ---------------------------------------------------------------------------

describe('MemoryCircuitBreaker — open state fallbacks', () => {
  async function openBreaker(): Promise<{
    breaker: MemoryCircuitBreaker;
    inner: FakeMemoryClient;
    queue: FakeRetryQueue;
  }> {
    const inner = new FakeMemoryClient();
    const queue = new FakeRetryQueue();
    const breaker = new MemoryCircuitBreaker({
      inner,
      retryQueue: queue as unknown as InstanceType<typeof import('../../src/memory/retry-queue.ts').RetryQueue>,
      failureThreshold: 1,
      openTimeoutMs: 30_000,
    });
    inner.failWith = new MemoryServiceError('svc', 500);
    await breaker.retain('trigger', TEST_SCOPE);
    inner.reset();
    return { breaker, inner, queue };
  }

  it('should return "__queued__" from retain and enqueue the entry', async () => {
    const { breaker, inner, queue } = await openBreaker();
    const result = await breaker.retain('text', TEST_SCOPE);
    expect(result).toBe('__queued__');
    expect(inner.calls).toBe(0);
    expect(queue.entries.length).toBe(2); // trigger + this call
  });

  it('should return [] from recall without calling inner', async () => {
    const { breaker, inner } = await openBreaker();
    const result = await breaker.recall('q', TEST_SCOPE, 10);
    expect(result).toStrictEqual([]);
    expect(inner.calls).toBe(0);
  });

  it('should return null from reflect without calling inner', async () => {
    const { breaker, inner } = await openBreaker();
    const result = await breaker.reflect('topic', TEST_SCOPE);
    expect(result).toBeNull();
    expect(inner.calls).toBe(0);
  });

  it('should return undefined from delete without calling inner', async () => {
    const { breaker, inner } = await openBreaker();
    const result = await breaker.delete('mem-id');
    expect(result).toBeUndefined();
    expect(inner.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — open → half_open → closed / open
// ---------------------------------------------------------------------------

describe('MemoryCircuitBreaker — open → half_open timer transition', () => {
  it('should transition from open to half_open after openTimeoutMs', async () => {
    const { breaker, inner } = makeBreaker({ failureThreshold: 1, openTimeoutMs: 1 });
    inner.failWith = new MemoryServiceError('svc', 500);
    await breaker.retain('x', TEST_SCOPE);
    expect(breaker.getMetrics().state).toBe(CircuitState.open);
    await delay(20);
    expect(breaker.getMetrics().state).toBe(CircuitState.half_open);
  });
});

describe('MemoryCircuitBreaker — half_open probe success → closed', () => {
  it('should transition to closed when probe succeeds', async () => {
    const { breaker, inner } = makeBreaker({ failureThreshold: 1, openTimeoutMs: 1 });
    inner.failWith = new MemoryServiceError('svc', 500);
    await breaker.retain('x', TEST_SCOPE);
    await delay(20);
    inner.reset();
    await breaker.retain('probe', TEST_SCOPE);
    expect(breaker.getMetrics().state).toBe(CircuitState.closed);
    expect(breaker.getMetrics().consecutiveFailures).toBe(0);
    expect(breaker.getMetrics().openedAt).toBeNull();
  });

  it('should accept subsequent calls normally after closing', async () => {
    const { breaker, inner } = makeBreaker({ failureThreshold: 1, openTimeoutMs: 1 });
    inner.failWith = new MemoryServiceError('svc', 500);
    await breaker.retain('x', TEST_SCOPE);
    await delay(20);
    inner.reset();
    await breaker.retain('probe', TEST_SCOPE);
    const result = await breaker.retain('normal', TEST_SCOPE);
    expect(result).toBe('mem-id');
    expect(inner.calls).toBe(2); // probe + normal
  });
});

describe('MemoryCircuitBreaker — half_open probe failure → open', () => {
  it('should re-open when probe fails with MemoryServiceError', async () => {
    const { breaker, inner } = makeBreaker({ failureThreshold: 1, openTimeoutMs: 1 });
    inner.failWith = new MemoryServiceError('svc', 500);
    await breaker.retain('x', TEST_SCOPE);
    await delay(20);
    // Probe also fails
    await breaker.retain('probe', TEST_SCOPE);
    expect(breaker.getMetrics().state).toBe(CircuitState.open);
    expect(breaker.getMetrics().openedAt).not.toBeNull();
  });

  it('should schedule a new open timer after probe failure', async () => {
    const { breaker, inner } = makeBreaker({ failureThreshold: 1, openTimeoutMs: 1 });
    inner.failWith = new MemoryServiceError('svc', 500);
    await breaker.retain('x', TEST_SCOPE);
    await delay(20);
    await breaker.retain('probe', TEST_SCOPE);
    expect(breaker.getMetrics().state).toBe(CircuitState.open);
    // New timer fires again
    await delay(20);
    expect(breaker.getMetrics().state).toBe(CircuitState.half_open);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — non-tripping errors do not count toward threshold
// ---------------------------------------------------------------------------

describe('MemoryCircuitBreaker — non-tripping errors', () => {
  it('should not count MemoryClientError toward failure threshold', async () => {
    const { breaker, inner } = makeBreaker({ failureThreshold: 1 });
    inner.failWith = new MemoryClientError('bad request', 400, 'Bad Request');
    await breaker.recall('q', TEST_SCOPE, 10);
    expect(breaker.getMetrics().state).toBe(CircuitState.closed);
    expect(breaker.getMetrics().consecutiveFailures).toBe(0);
  });

  it('should not count MemoryTimeoutError toward failure threshold', async () => {
    const { breaker, inner } = makeBreaker({ failureThreshold: 1 });
    inner.failWith = new MemoryTimeoutError('timed out');
    await breaker.recall('q', TEST_SCOPE, 10);
    expect(breaker.getMetrics().state).toBe(CircuitState.closed);
    expect(breaker.getMetrics().consecutiveFailures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — INFO log on each transition
// ---------------------------------------------------------------------------

describe('MemoryCircuitBreaker — INFO logs on transitions', () => {
  it('should log "Circuit breaker → open" when opening', async () => {
    const spy = spyOn(console, 'info').mockImplementation(() => undefined);
    const { breaker, inner } = makeBreaker({ failureThreshold: 1 });
    inner.failWith = new MemoryServiceError('svc', 500);
    await breaker.retain('x', TEST_SCOPE);
    expect(spy).toHaveBeenCalledWith('Circuit breaker → open');
    spy.mockRestore();
  });

  it('should log "Circuit breaker → half_open" when transitioning to half_open', async () => {
    const spy = spyOn(console, 'info').mockImplementation(() => undefined);
    const { breaker, inner } = makeBreaker({ failureThreshold: 1, openTimeoutMs: 1 });
    inner.failWith = new MemoryServiceError('svc', 500);
    await breaker.retain('x', TEST_SCOPE);
    await delay(20);
    const calls = spy.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain('Circuit breaker → half_open');
    spy.mockRestore();
  });

  it('should log "Circuit breaker → closed" when probe succeeds', async () => {
    const spy = spyOn(console, 'info').mockImplementation(() => undefined);
    const { breaker, inner } = makeBreaker({ failureThreshold: 1, openTimeoutMs: 1 });
    inner.failWith = new MemoryServiceError('svc', 500);
    await breaker.retain('x', TEST_SCOPE);
    await delay(20);
    inner.reset();
    await breaker.retain('probe', TEST_SCOPE);
    const calls = spy.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain('Circuit breaker → closed');
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Property 6: Circuit breaker transitions closed→open after exactly
//             failureThreshold consecutive MemoryServiceErrors
//
// Feature: phase-6.1-memory-infrastructure, Property 6: Circuit breaker
// transitions closed→open after exactly failureThreshold consecutive
// MemoryServiceErrors
// ---------------------------------------------------------------------------

describe('Property 6: closed→open after exactly failureThreshold consecutive MemoryServiceErrors', () => {
  it('property: stays closed after N-1 failures then opens on the Nth', async () => {
    // Feature: phase-6.1-memory-infrastructure, Property 6: Circuit breaker transitions closed→open after exactly failureThreshold consecutive MemoryServiceErrors
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (n) => {
        const inner = new FakeMemoryClient();
        const queue = new FakeRetryQueue();
        const breaker = new MemoryCircuitBreaker({
          inner,
          retryQueue: queue as unknown as InstanceType<typeof import('../../src/memory/retry-queue.ts').RetryQueue>,
          failureThreshold: n,
          openTimeoutMs: 60_000,
        });

        inner.failWith = new MemoryServiceError('svc', 500);

        // First N-1 failures: must remain closed
        for (let i = 0; i < n - 1; i++) {
          await breaker.retain(`call-${i}`, TEST_SCOPE);
          expect(breaker.getMetrics().state).toBe(CircuitState.closed);
          expect(breaker.getMetrics().consecutiveFailures).toBe(i + 1);
        }

        // Nth failure: must open
        await breaker.retain(`call-${n - 1}`, TEST_SCOPE);
        expect(breaker.getMetrics().state).toBe(CircuitState.open);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: MemoryClientError and MemoryTimeoutError never trip the
//             circuit breaker
//
// Feature: phase-6.1-memory-infrastructure, Property 7: MemoryClientError
// and MemoryTimeoutError never trip the circuit breaker
// ---------------------------------------------------------------------------

describe('Property 7: MemoryClientError and MemoryTimeoutError never trip the circuit breaker', () => {
  it('property: any count of MemoryClientErrors leaves state closed with 0 consecutive failures', async () => {
    // Feature: phase-6.1-memory-infrastructure, Property 7: MemoryClientError and MemoryTimeoutError never trip the circuit breaker
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 50 }), async (count) => {
        const inner = new FakeMemoryClient();
        const queue = new FakeRetryQueue();
        const breaker = new MemoryCircuitBreaker({
          inner,
          retryQueue: queue as unknown as InstanceType<typeof import('../../src/memory/retry-queue.ts').RetryQueue>,
          failureThreshold: 1,
          openTimeoutMs: 60_000,
        });

        inner.failWith = new MemoryClientError('bad request', 400, 'body');
        for (let i = 0; i < count; i++) {
          await breaker.recall('q', TEST_SCOPE, 10);
        }

        expect(breaker.getMetrics().state).toBe(CircuitState.closed);
        expect(breaker.getMetrics().consecutiveFailures).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('property: any count of MemoryTimeoutErrors leaves state closed with 0 consecutive failures', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 50 }), async (count) => {
        const inner = new FakeMemoryClient();
        const queue = new FakeRetryQueue();
        const breaker = new MemoryCircuitBreaker({
          inner,
          retryQueue: queue as unknown as InstanceType<typeof import('../../src/memory/retry-queue.ts').RetryQueue>,
          failureThreshold: 1,
          openTimeoutMs: 60_000,
        });

        inner.failWith = new MemoryTimeoutError('timed out');
        for (let i = 0; i < count; i++) {
          await breaker.recall('q', TEST_SCOPE, 10);
        }

        expect(breaker.getMetrics().state).toBe(CircuitState.closed);
        expect(breaker.getMetrics().consecutiveFailures).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8: Open-state calls return safe fallbacks and never reach the
//             inner client
//
// Feature: phase-6.1-memory-infrastructure, Property 8: Open-state calls
// return safe fallbacks and never reach the inner client
// ---------------------------------------------------------------------------

describe('Property 8: Open-state calls return safe fallbacks and never reach the inner client', () => {
  it('property: retain/recall/reflect/delete all return fallbacks with zero inner calls', async () => {
    // Feature: phase-6.1-memory-infrastructure, Property 8: Open-state calls return safe fallbacks and never reach the inner client
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.record({ workspaceId: fc.string() }),
        async (text, scope) => {
          const inner = new FakeMemoryClient();
          const queue = new FakeRetryQueue();
          const breaker = new MemoryCircuitBreaker({
            inner,
            retryQueue: queue as unknown as InstanceType<typeof import('../../src/memory/retry-queue.ts').RetryQueue>,
            failureThreshold: 1,
            openTimeoutMs: 60_000,
          });

          // Open the breaker
          inner.failWith = new MemoryServiceError('svc', 500);
          await breaker.retain('trigger', TEST_SCOPE);

          // Reset call counter; inner still configured to fail but must not be called
          inner.calls = 0;

          const retainResult = await breaker.retain(text, scope);
          const recallResult = await breaker.recall(text, scope, 10);
          const reflectResult = await breaker.reflect(text, scope);
          const deleteResult = await breaker.delete(text);

          expect(retainResult).toBe('__queued__');
          expect(recallResult).toStrictEqual([]);
          expect(reflectResult).toBeNull();
          expect(deleteResult).toBeUndefined();
          expect(inner.calls).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: In half_open state, exactly one probe call reaches the inner
//             client; all others get fallbacks
//
// Feature: phase-6.1-memory-infrastructure, Property 9: In half_open state,
// exactly one probe call reaches the inner client
// ---------------------------------------------------------------------------

describe('Property 9: In half_open state, exactly one probe call reaches the inner client', () => {
  it('property: while a probe is in-flight, concurrent calls receive fallbacks', async () => {
    // Feature: phase-6.1-memory-infrastructure, Property 9: In half_open state, exactly one probe call reaches the inner client
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 20 }), async (extraCalls) => {
        const inner = new FakeMemoryClient();
        const queue = new FakeRetryQueue();
        const breaker = new MemoryCircuitBreaker({
          inner,
          retryQueue: queue as unknown as InstanceType<typeof import('../../src/memory/retry-queue.ts').RetryQueue>,
          failureThreshold: 1,
          openTimeoutMs: 1,
        });

        // Trip the breaker
        inner.failWith = new MemoryServiceError('svc', 500);
        await breaker.retain('trip', TEST_SCOPE);
        await delay(20);
        expect(breaker.getMetrics().state).toBe(CircuitState.half_open);

        // Set up probe to hang until we release it
        let resolveProbe!: () => void;
        const probeBarrier = new Promise<void>((res) => {
          resolveProbe = res;
        });
        inner.failWith = null;
        inner.calls = 0;

        // Override retain to block on the barrier
        const originalRetain = inner.retain.bind(inner);
        let probeStarted = false;
        inner.retain = async (text: string, s: MemoryScope): Promise<string> => {
          if (!probeStarted) {
            probeStarted = true;
            await probeBarrier;
          }
          return originalRetain(text, s);
        };

        // Start the probe (does not await yet)
        const probePromise = breaker.retain('probe', TEST_SCOPE);

        // Give the event loop a tick so the probe sets inProbe = true
        await delay(0);

        // Extra calls while probe is in-flight — all must get fallbacks
        const extras: Promise<string>[] = [];
        for (let i = 0; i < extraCalls; i++) {
          extras.push(breaker.retain(`extra-${i}`, TEST_SCOPE));
        }
        const extraResults = await Promise.all(extras);
        for (const r of extraResults) {
          expect(r).toBe('__queued__');
        }

        // The inner client should have been entered exactly once so far
        // (retain was called for the probe and is awaiting the barrier)
        // Note: inner.calls won't be incremented until after barrier releases
        // because originalRetain increments it.

        // Release the probe
        resolveProbe();
        await probePromise;

        expect(breaker.getMetrics().state).toBe(CircuitState.closed);
      }),
      { numRuns: 100 },
    );
  });
});
