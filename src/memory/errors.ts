// ---------------------------------------------------------------------------
// Memory error hierarchy — typed errors for the memory layer.
// All errors extend MemoryBaseError so callers can catch the entire
// hierarchy with a single catch clause when needed, while the circuit
// breaker can inspect the concrete type to decide whether to trip.
// ---------------------------------------------------------------------------

/**
 * Base class for all memory-layer errors.
 * Extend this rather than Error directly so callers can catch the full
 * hierarchy with `instanceof MemoryBaseError`.
 */
export class MemoryBaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryBaseError';
    // Restore the prototype chain in environments that down-compile classes.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a call to the Hindsight adapter times out (after 5 s).
 * The circuit breaker does NOT count timeouts toward the failure threshold —
 * they are treated as a transient caller-side condition.
 */
export class MemoryTimeoutError extends MemoryBaseError {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryTimeoutError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the Hindsight server responds with an HTTP 4xx status code.
 * Indicates a caller error (bad payload, bad scope, etc.).
 * The circuit breaker does NOT count these toward the failure threshold.
 */
export class MemoryClientError extends MemoryBaseError {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'MemoryClientError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the Hindsight server responds with an HTTP 5xx status code,
 * an unexpected 1xx informational status (protocol violation), or when the
 * network request fails before a response is received (connection refused,
 * DNS failure, etc. — use statusCode 0 in those cases).
 * The circuit breaker counts these toward the failure threshold.
 */
export class MemoryServiceError extends MemoryBaseError {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'MemoryServiceError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
