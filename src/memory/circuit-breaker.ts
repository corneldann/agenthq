// ---------------------------------------------------------------------------
// MemoryCircuitBreaker — 3-state FSM wrapping any IMemoryClient.
//
// States: closed → open → half_open → closed (or half_open → open on failure)
//
// Only MemoryServiceError and raw network errors (non-MemoryBaseError throws)
// count toward the failure threshold. MemoryClientError (4xx) and
// MemoryTimeoutError do NOT increment consecutiveFailures.
//
// Open-state fallbacks:
//   retain  → enqueues to RetryQueue, returns '__queued__'
//   recall  → returns []
//   reflect → returns null
//   delete  → no-op (returns undefined)
//
// The inProbe flag ensures exactly one probe is in-flight during half_open;
// all other calls during that window receive fallbacks without reaching
// the inner client.
// ---------------------------------------------------------------------------

import {
  CircuitState,
  type CircuitBreakerMetrics,
  type IMemoryClient,
  type Memory,
  type MemoryScope,
  type RetryQueueEntry,
} from './types.ts';
import {
  MemoryBaseError,
  MemoryClientError,
  MemoryTimeoutError,
  MemoryServiceError,
} from './errors.ts';
import { RetryQueue } from './retry-queue.ts';

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export type CircuitBreakerOptions = {
  inner: IMemoryClient;
  retryQueue: RetryQueue;
  failureThreshold: number;
  openTimeoutMs: number;
};

// ---------------------------------------------------------------------------
// MemoryCircuitBreaker
// ---------------------------------------------------------------------------

export class MemoryCircuitBreaker implements IMemoryClient {
  readonly #inner: IMemoryClient;
  readonly #retryQueue: RetryQueue;
  readonly #failureThreshold: number;
  readonly #openTimeoutMs: number;

  #state: typeof CircuitState[keyof typeof CircuitState] = CircuitState.closed;
  #consecutiveFailures: number = 0;
  #totalFailures: number = 0;
  #totalSuccesses: number = 0;
  #lastFailureAt: string | null = null;
  #lastSuccessAt: string | null = null;
  #openedAt: string | null = null;

  // When in half_open: true while a probe call is in-flight; prevents
  // additional calls from reaching the inner client simultaneously.
  #inProbe: boolean = false;

  // Timer handle for open → half_open transition.
  #openTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: CircuitBreakerOptions) {
    this.#inner = options.inner;
    this.#retryQueue = options.retryQueue;
    this.#failureThreshold = options.failureThreshold;
    this.#openTimeoutMs = options.openTimeoutMs;
  }

  // -------------------------------------------------------------------------
  // IMemoryClient implementation
  // -------------------------------------------------------------------------

  async retain(text: string, scope: MemoryScope): Promise<string> {
    if (this.#isFallbackRequired()) {
      this.#enqueueForRetry(text, scope);
      return '__queued__';
    }

    const probing = this.#state === CircuitState.half_open;
    if (probing) {
      this.#inProbe = true;
    }

    try {
      const id = await this.#inner.retain(text, scope);
      this.#onSuccess(probing);
      return id;
    } catch (err) {
      this.#onFailure(err, probing, () => this.#enqueueForRetry(text, scope));
      return '__queued__';
    }
  }

  async recall(query: string, scope: MemoryScope, limit: number, includeStale: boolean = false): Promise<Memory[]> {
    if (this.#isFallbackRequired()) {
      return [];
    }

    const probing = this.#state === CircuitState.half_open;
    if (probing) {
      this.#inProbe = true;
    }

    try {
      const memories = await this.#inner.recall(query, scope, limit, includeStale);
      this.#onSuccess(probing);
      return memories;
    } catch (err) {
      this.#onFailure(err, probing, () => undefined);
      return [];
    }
  }

  async list(scope: MemoryScope, pageSize: number, cursor: string | null, includeStale: boolean = false): Promise<{
    memories: Memory[];
    nextCursor: string | null;
    total: number;
  }> {
    if (this.#isFallbackRequired()) {
      return { memories: [], nextCursor: null, total: 0 };
    }

    const probing = this.#state === CircuitState.half_open;
    if (probing) {
      this.#inProbe = true;
    }

    try {
      const result = await this.#inner.list(scope, pageSize, cursor, includeStale);
      this.#onSuccess(probing);
      return result;
    } catch (err) {
      this.#onFailure(err, probing, () => undefined);
      return { memories: [], nextCursor: null, total: 0 };
    }
  }

  async get(id: string): Promise<Memory | null> {
    if (this.#isFallbackRequired()) {
      return null;
    }

    const probing = this.#state === CircuitState.half_open;
    if (probing) {
      this.#inProbe = true;
    }

    try {
      const memory = await this.#inner.get(id);
      this.#onSuccess(probing);
      return memory;
    } catch (err) {
      this.#onFailure(err, probing, () => undefined);
      return null;
    }
  }

  async reflect(topic: string, scope: MemoryScope): Promise<string | null> {
    if (this.#isFallbackRequired()) {
      return null;
    }

    const probing = this.#state === CircuitState.half_open;
    if (probing) {
      this.#inProbe = true;
    }

    try {
      const result = await this.#inner.reflect(topic, scope);
      this.#onSuccess(probing);
      return result;
    } catch (err) {
      this.#onFailure(err, probing, () => undefined);
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    if (this.#isFallbackRequired()) {
      return;
    }

    const probing = this.#state === CircuitState.half_open;
    if (probing) {
      this.#inProbe = true;
    }

    try {
      await this.#inner.delete(id);
      this.#onSuccess(probing);
    } catch (err) {
      this.#onFailure(err, probing, () => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  /**
   * Return a plain-object snapshot of the current circuit breaker state.
   * No references to mutable internal fields are included in the returned
   * object — callers cannot observe future state changes through it.
   */
  getMetrics(): CircuitBreakerMetrics {
    return {
      state: this.#state,
      consecutiveFailures: this.#consecutiveFailures,
      totalFailures: this.#totalFailures,
      totalSuccesses: this.#totalSuccesses,
      lastFailureAt: this.#lastFailureAt,
      lastSuccessAt: this.#lastSuccessAt,
      openedAt: this.#openedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Returns true when calls must be served from fallbacks without reaching
   * the inner client:
   * - state is open, OR
   * - state is half_open AND a probe is already in-flight.
   */
  #isFallbackRequired(): boolean {
    if (this.#state === CircuitState.open) {
      return true;
    }
    if (this.#state === CircuitState.half_open && this.#inProbe) {
      return true;
    }
    return false;
  }

  /**
   * Determine whether the thrown error should count toward the failure
   * threshold. Only MemoryServiceError and non-MemoryBaseError errors
   * (raw network errors) trip the breaker.
   */
  #isTrippingError(err: unknown): boolean {
    if (err instanceof MemoryServiceError) {
      return true;
    }
    // MemoryClientError and MemoryTimeoutError are both MemoryBaseError
    // subclasses — they do NOT trip the breaker.
    if (err instanceof MemoryBaseError) {
      return false;
    }
    // Any non-MemoryBaseError (e.g. fetch-level network errors) counts as a
    // service failure and trips the breaker.
    return true;
  }

  /** Called after a successful call to the inner client. */
  #onSuccess(wasProbe: boolean): void {
    this.#totalSuccesses++;
    this.#lastSuccessAt = new Date().toISOString();

    if (wasProbe || this.#state === CircuitState.half_open) {
      this.#transitionTo(CircuitState.closed);
      this.#consecutiveFailures = 0;
      this.#inProbe = false;
    } else {
      // In closed state a success resets the consecutive counter.
      this.#consecutiveFailures = 0;
    }
  }

  /**
   * Called after a failed call to the inner client.
   * @param err         The thrown error.
   * @param wasProbe    Whether this call was the half_open probe.
   * @param onOpen      Callback invoked when transitioning to open so the
   *                    caller can enqueue its payload for retry.
   */
  #onFailure(err: unknown, wasProbe: boolean, onOpen: () => void): void {
    this.#lastFailureAt = new Date().toISOString();

    if (!this.#isTrippingError(err)) {
      // Non-tripping errors (4xx, timeout): do not count, do not transition.
      if (wasProbe) {
        // Release the probe slot so the next call can try again.
        this.#inProbe = false;
      }
      return;
    }

    // Tripping error path.
    this.#totalFailures++;
    this.#consecutiveFailures++;

    if (wasProbe) {
      // Probe failed — go back to open and restart the timer.
      this.#inProbe = false;
      this.#transitionTo(CircuitState.open);
      onOpen();
      this.#scheduleHalfOpen();
      return;
    }

    // Closed state: check whether threshold is reached.
    if (
      this.#state === CircuitState.closed &&
      this.#consecutiveFailures >= this.#failureThreshold
    ) {
      this.#transitionTo(CircuitState.open);
      onOpen();
      this.#scheduleHalfOpen();
    }
  }

  /** Enqueue a failed retain payload to the RetryQueue. */
  #enqueueForRetry(text: string, scope: MemoryScope): void {
    const entry: RetryQueueEntry = {
      id: crypto.randomUUID(),
      text,
      scope,
      queuedAt: new Date().toISOString(),
      attempts: 0,
    };
    this.#retryQueue.enqueue(entry);
  }

  /** Set a timer to transition from open to half_open after openTimeoutMs. */
  #scheduleHalfOpen(): void {
    if (this.#openTimer !== null) {
      clearTimeout(this.#openTimer);
    }
    this.#openTimer = setTimeout(() => {
      this.#openTimer = null;
      if (this.#state === CircuitState.open) {
        this.#transitionTo(CircuitState.half_open);
      }
    }, this.#openTimeoutMs);
  }

  /** Perform a state transition and emit the required INFO log. */
  #transitionTo(next: typeof CircuitState[keyof typeof CircuitState]): void {
    this.#state = next;

    if (next === CircuitState.open) {
      this.#openedAt = new Date().toISOString();
      console.info('Circuit breaker → open');
    } else if (next === CircuitState.half_open) {
      console.info('Circuit breaker → half_open');
    } else {
      // closed
      this.#openedAt = null;
      console.info('Circuit breaker → closed');
    }
  }
}
