// src/routes/memory-browser.ts
// Route handlers for memory browser: search, list, CRUD, and reflection endpoints.
//
// All routes check MEMORY_ENABLED and circuit breaker state before delegating to
// IMemoryClient. workspaceId is validated as a non-empty string on every route.

import type { Router } from '../router.ts';
import { MEMORY_ENABLED } from '../constants.ts';
import type { MemoryCircuitBreaker } from '../memory/circuit-breaker.ts';
import type { IMemoryClient } from '../memory/types.ts';
import {
  MemoryTimeoutError,
  MemoryServiceError,
  MemoryClientError,
} from '../memory/errors.ts';

// ---------------------------------------------------------------------------
// Guard functions and error handling
// ---------------------------------------------------------------------------

/**
 * Guard that checks if memory is enabled.
 *
 * Returns a 503 response with `{ error: 'memory disabled' }` when MEMORY_ENABLED=false.
 * This guard applies to all protected memory routes except health/debug endpoints.
 *
 * @returns Response with 503 status if memory is disabled, null otherwise
 *
 * @example
 * ```typescript
 * const disabledResponse = checkMemoryEnabled();
 * if (disabledResponse !== null) return disabledResponse;
 * ```
 */
export function checkMemoryEnabled(): Response | null {
  if (!MEMORY_ENABLED) {
    return jsonResponse({ error: 'memory disabled' }, 503);
  }
  return null;
}

/**
 * Guard that checks circuit breaker state.
 *
 * Returns a 502 response with circuit breaker metrics when the breaker is in Open state.
 * This allows clients to distinguish circuit breaker failures from other types of 502 errors.
 *
 * @param breaker - MemoryCircuitBreaker instance, or null when memory is disabled
 * @returns Response with 502 status if circuit is open, null otherwise
 *
 * @example
 * ```typescript
 * const openResponse = checkCircuitBreaker(breaker);
 * if (openResponse !== null) return openResponse;
 * ```
 */
export function checkCircuitBreaker(breaker: MemoryCircuitBreaker | null): Response | null {
  if (breaker === null) {
    return null;
  }

  const metrics = breaker.getMetrics();
  if (metrics.state === 'open') {
    return jsonResponse(
      {
        error: 'circuit open',
        metrics,
      },
      502,
    );
  }

  return null;
}

/**
 * Guard that validates workspaceId from query parameters.
 *
 * Returns a 400 response when workspaceId is missing, empty, or consists only of whitespace.
 * This guard applies to all protected memory routes that require workspace scoping.
 *
 * @param req - Request object containing URL with query parameters
 * @returns Response with 400 status if workspaceId is invalid, null otherwise
 *
 * @example
 * ```typescript
 * const validationError = validateWorkspaceId(req);
 * if (validationError !== null) return validationError;
 * ```
 */
export function validateWorkspaceId(req: Request): Response | null {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get('workspaceId');

  if (workspaceId === null || workspaceId.trim() === '') {
    return jsonResponse({ error: 'workspaceId required' }, 400);
  }

  return null;
}

/**
 * Map memory layer errors to HTTP status codes and response bodies.
 *
 * This function implements the error mapping table from the design document:
 * - MemoryTimeoutError → 504 (database timeout)
 * - MemoryServiceError → 502 (upstream service failure)
 * - MemoryClientError → 400 (client error, includes status code from upstream)
 * - Unknown errors → 500 (internal server error)
 *
 * @param err - Error thrown from IMemoryClient operation
 * @returns Response object with appropriate status code and error message
 *
 * @example
 * ```typescript
 * try {
 *   await client.recall(query, scope, limit);
 * } catch (err) {
 *   return mapMemoryError(err);
 * }
 * ```
 */
export function mapMemoryError(err: unknown): Response {
  if (err instanceof MemoryTimeoutError) {
    return jsonResponse({ error: 'database timeout' }, 504);
  }

  if (err instanceof MemoryServiceError) {
    return jsonResponse(
      {
        error: err.message,
        statusCode: err.statusCode,
      },
      502,
    );
  }

  if (err instanceof MemoryClientError) {
    return jsonResponse(
      {
        error: err.message,
        statusCode: err.statusCode,
      },
      400,
    );
  }

  // Unknown error — fallback to 500
  const message = err instanceof Error ? err.message : 'Unknown error';
  return jsonResponse({ error: message }, 500);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a JSON Response with consistent headers.
 *
 * @param data - Data to serialize as JSON
 * @param status - HTTP status code (default: 200)
 * @returns Response object with JSON content type
 */
function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Resolve and clamp a query parameter limit to a valid range.
 *
 * Pure function with zero side effects — accepts raw query parameter string,
 * returns a clamped integer within [1, max].
 *
 * @param raw - Raw query parameter string (e.g., from URL searchParams), or null if absent
 * @param defaultVal - Default value to use when raw is null or invalid
 * @param max - Maximum allowed value (values exceeding this are clamped)
 * @returns Integer in range [1, max]
 *
 * @example
 * ```typescript
 * // Absent parameter → default
 * resolveLimit(null, 20, 100);  // → 20
 *
 * // Valid parameter → parsed value
 * resolveLimit('50', 20, 100);  // → 50
 *
 * // Exceeds max → clamped
 * resolveLimit('200', 20, 100); // → 100
 *
 * // Invalid input → default
 * resolveLimit('abc', 20, 100); // → 20
 * resolveLimit('0', 20, 100);   // → 20
 * ```
 */
export function resolveLimit(raw: string | null, defaultVal: number, max: number): number {
  if (raw === null) return defaultVal;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return Math.min(n, max);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register memory browser routes on the given router.
 *
 * Registers six REST endpoints for memory search, list, CRUD, and reflection:
 * - GET /api/memory/search — search memories by query string
 * - GET /api/memory/list — paginated memory list
 * - GET /api/memory/:id — fetch single memory by ID
 * - PATCH /api/memory/:id — update memory text
 * - DELETE /api/memory/:id — delete memory by ID
 * - POST /api/memory/reflect — synthesize reflection on a topic
 *
 * All routes enforce:
 * 1. Feature flag guard (MEMORY_ENABLED=false → 503)
 * 2. Circuit breaker state check (Open → 502)
 * 3. workspaceId validation (missing/empty → 400)
 *
 * @param router - Application router instance
 * @param client - IMemoryClient implementation for memory operations
 * @param breaker - MemoryCircuitBreaker wrapping the client, or null when MEMORY_ENABLED=false
 *
 * @example
 * ```typescript
 * const router = createRouter();
 * const client = createMemoryClient();
 * const breaker = new MemoryCircuitBreaker({ inner: client, ... });
 * register(router, client, breaker);
 * ```
 */
export function register(
  router: Router,
  client: IMemoryClient,
  breaker: MemoryCircuitBreaker | null,
): void {
  // Placeholder routes — full implementation in subsequent tasks
  // Task 1.1 establishes the module structure and helper functions only

  // GET /api/memory/search
  router.get('/api/memory/search', (_req, _params) => {
    if (!MEMORY_ENABLED) {
      return jsonResponse({ error: 'memory disabled' }, 503);
    }
    // TODO: Implement search handler (Task 1.2)
    return jsonResponse({ memories: [] });
  });

  // GET /api/memory/list
  router.get('/api/memory/list', (_req, _params) => {
    if (!MEMORY_ENABLED) {
      return jsonResponse({ error: 'memory disabled' }, 503);
    }
    // TODO: Implement list handler (Task 1.3)
    return jsonResponse({ memories: [], nextCursor: null, total: 0 });
  });

  // GET /api/memory/:id
  router.get('/api/memory/:id', (_req, _params) => {
    if (!MEMORY_ENABLED) {
      return jsonResponse({ error: 'memory disabled' }, 503);
    }
    // TODO: Implement get handler (Task 1.4)
    return jsonResponse({ error: 'not implemented' }, 501);
  });

  // PATCH /api/memory/:id
  router.post('/api/memory/:id', (_req, _params) => {
    if (!MEMORY_ENABLED) {
      return jsonResponse({ error: 'memory disabled' }, 503);
    }
    // TODO: Implement update handler (Task 1.5)
    return jsonResponse({ error: 'not implemented' }, 501);
  });

  // DELETE /api/memory/:id
  router.delete('/api/memory/:id', (_req, _params) => {
    if (!MEMORY_ENABLED) {
      return jsonResponse({ error: 'memory disabled' }, 503);
    }
    // TODO: Implement delete handler (Task 1.6)
    return jsonResponse({ error: 'not implemented' }, 204);
  });

  // POST /api/memory/reflect
  router.post('/api/memory/reflect', (_req, _params) => {
    if (!MEMORY_ENABLED) {
      return jsonResponse({ error: 'memory disabled' }, 503);
    }
    // TODO: Implement reflect handler (Task 1.7)
    return jsonResponse({ reflection: null });
  });
}
