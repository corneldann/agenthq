// ---------------------------------------------------------------------------
// Memory client factory — composes the Hindsight adapter, circuit breaker,
// and retry queue into a single IMemoryClient, or returns a no-op client
// when memory is disabled via the MEMORY_ENABLED feature flag.
// ---------------------------------------------------------------------------

import type { IMemoryClient, Memory, MemoryScope } from './types.ts';
import { HindsightAdapter } from './hindsight.ts';
import { MemoryCircuitBreaker } from './circuit-breaker.ts';
import { RetryQueue } from './retry-queue.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type MemoryClientConfig = {
  /** When false, createMemoryClient() returns NoOpMemoryClient immediately. */
  enabled: boolean;
  /** Base URL of the Hindsight MCP server, e.g. 'http://localhost:3100'. */
  baseUrl: string;
  /** Filesystem path for the JSONL retry queue file. */
  retryPath: string;
  /**
   * Number of consecutive MemoryServiceErrors before the circuit opens.
   * @default 3
   */
  failureThreshold?: number;
  /**
   * Milliseconds the circuit stays open before transitioning to half_open.
   * @default 30_000
   */
  openTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// NoOpMemoryClient
// ---------------------------------------------------------------------------

/**
 * Safe no-operation implementation of IMemoryClient.
 * Returned by createMemoryClient() when config.enabled is false.
 * All methods return their safe zero-values without side-effects.
 */
export class NoOpMemoryClient implements IMemoryClient {
  retain(_text: string, _scope: MemoryScope): Promise<string> {
    return Promise.resolve('');
  }

  recall(_query: string, _scope: MemoryScope, _limit: number): Promise<Memory[]> {
    return Promise.resolve([]);
  }

  list(_scope: MemoryScope, _pageSize: number, _cursor: string | null): Promise<{
    memories: Memory[];
    nextCursor: string | null;
    total: number;
  }> {
    return Promise.resolve({ memories: [], nextCursor: null, total: 0 });
  }

  get(_id: string): Promise<Memory | null> {
    return Promise.resolve(null);
  }

  reflect(_topic: string, _scope: MemoryScope): Promise<string | null> {
    return Promise.resolve(null);
  }

  delete(_id: string): Promise<void> {
    return Promise.resolve(undefined);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Compose and return an IMemoryClient according to the provided config.
 *
 * When config.enabled is false: returns a NoOpMemoryClient — no adapters,
 * no timers, and no file handles are created.
 *
 * When config.enabled is true: composes HindsightAdapter → RetryQueue →
 * MemoryCircuitBreaker and returns the breaker as the public client.
 */
export function createMemoryClient(config: MemoryClientConfig): IMemoryClient {
  if (!config.enabled) {
    return new NoOpMemoryClient();
  }

  const adapter = new HindsightAdapter(config.baseUrl);
  const retryQueue = new RetryQueue(config.retryPath, adapter);

  return new MemoryCircuitBreaker({
    inner: adapter,
    retryQueue,
    failureThreshold: config.failureThreshold ?? 3,
    openTimeoutMs: config.openTimeoutMs ?? 30_000,
  });
}
