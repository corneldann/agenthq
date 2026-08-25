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
  router.get('/api/memory/search', async (req, _params) => {
    // Guard: feature flag check
    const disabledResponse = checkMemoryEnabled();
    if (disabledResponse !== null) return disabledResponse;

    // Guard: circuit breaker state check
    const openResponse = checkCircuitBreaker(breaker);
    if (openResponse !== null) return openResponse;

    // Guard: workspaceId validation
    const validationError = validateWorkspaceId(req);
    if (validationError !== null) return validationError;

    // Parse query parameters
    const url = new URL(req.url);
    const query = url.searchParams.get('q') ?? '';
    const workspaceId = url.searchParams.get('workspaceId') ?? ''; // Already validated as non-empty
    const rawLimit = url.searchParams.get('limit');
    const limit = resolveLimit(rawLimit, 20, 100);

    try {
      // Call client.recall with parsed params
      const memories = await client.recall(
        query,
        { workspaceId },
        limit,
      );

      return jsonResponse(memories);
    } catch (err) {
      // Map errors to HTTP status codes per error mapping table
      return mapMemoryError(err);
    }
  });

  // GET /api/memory/list
  router.get('/api/memory/list', async (req, _params) => {
    // Guard: feature flag check
    const disabledResponse = checkMemoryEnabled();
    if (disabledResponse !== null) return disabledResponse;

    // Guard: circuit breaker state check
    const openResponse = checkCircuitBreaker(breaker);
    if (openResponse !== null) return openResponse;

    // Guard: workspaceId validation
    const validationError = validateWorkspaceId(req);
    if (validationError !== null) return validationError;

    // Parse query parameters
    const url = new URL(req.url);
    const workspaceId = url.searchParams.get('workspaceId') ?? ''; // Already validated as non-empty
    const cursor = url.searchParams.get('cursor');
    const rawPageSize = url.searchParams.get('pageSize');
    const pageSize = resolveLimit(rawPageSize, 50, 100);

    try {
      // Call client.list with parsed params
      const result = await client.list(
        { workspaceId },
        pageSize,
        cursor,
      );

      // Sort memories by createdAt DESC
      // Requirement 1.2: memories sorted by createdAt DESC
      const sortedMemories = result.memories.slice().sort((a, b) => {
        // ISO 8601 strings can be compared lexicographically
        // For descending order: b.createdAt - a.createdAt
        return b.createdAt.localeCompare(a.createdAt);
      });

      // Return response with sorted memories
      return jsonResponse({
        memories: sortedMemories,
        nextCursor: result.nextCursor,
        total: result.total,
      });
    } catch (err) {
      // Map errors to HTTP status codes per error mapping table
      return mapMemoryError(err);
    }
  });

  // GET /api/memory/:id
  router.get('/api/memory/:id', async (req, params) => {
    // Guard: feature flag check
    const disabledResponse = checkMemoryEnabled();
    if (disabledResponse !== null) return disabledResponse;

    // Guard: circuit breaker state check
    const openResponse = checkCircuitBreaker(breaker);
    if (openResponse !== null) return openResponse;

    // Note: workspaceId validation is skipped for single-item GET
    // (Requirement 1.3: "skip workspaceId validation for single-item GET")

    // Parse id param from URL
    const id = params.id;
    if (!id || id.trim() === '') {
      return jsonResponse({ error: 'id required' }, 400);
    }

    try {
      // Call client.get with the parsed id
      const memory = await client.get(id);

      // Return Memory object or 404 if not found
      if (memory === null) {
        return jsonResponse({ error: 'not found' }, 404);
      }

      return jsonResponse(memory);
    } catch (err) {
      // Map errors to HTTP status codes per error mapping table
      return mapMemoryError(err);
    }
  });

  // PATCH /api/memory/:id
  router.post('/api/memory/:id', async (req, params) => {
    // Guard: feature flag check
    const disabledResponse = checkMemoryEnabled();
    if (disabledResponse !== null) return disabledResponse;

    // Guard: circuit breaker state check
    const openResponse = checkCircuitBreaker(breaker);
    if (openResponse !== null) return openResponse;

    // Guard: workspaceId validation
    const validationError = validateWorkspaceId(req);
    if (validationError !== null) return validationError;

    // Parse id param from URL
    const id = params.id;
    if (!id || id.trim() === '') {
      return jsonResponse({ error: 'id required' }, 400);
    }

    // Parse request body
    let body: { text?: string };
    try {
      body = await req.json();
    } catch (err) {
      return jsonResponse({ error: 'invalid JSON body' }, 400);
    }

    // Validate text field
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      return jsonResponse({ error: 'text field is required and must be a non-empty string' }, 400);
    }

    const url = new URL(req.url);
    const workspaceId = url.searchParams.get('workspaceId') ?? ''; // Already validated as non-empty

    try {
      // First, fetch the existing memory to get its scope
      const existingMemory = await client.get(id);
      if (existingMemory === null) {
        return jsonResponse({ error: 'not found' }, 404);
      }

      // Call client.retain with updated text and existing scope (replace operation)
      // Requirement 1.4: PATCH accepts { text: string } and updates via retain
      // The retain operation with the same scope should replace/update the memory
      await client.retain(body.text, existingMemory.scope);

      // Fetch the updated memory to return it
      const updatedMemory = await client.get(id);
      if (updatedMemory === null) {
        // Shouldn't happen, but handle gracefully
        return jsonResponse({ error: 'memory not found after update' }, 500);
      }

      // Return updated Memory object
      return jsonResponse(updatedMemory);
    } catch (err) {
      // Map errors to HTTP status codes per error mapping table
      return mapMemoryError(err);
    }
  });

  // DELETE /api/memory/:id
  router.delete('/api/memory/:id', async (req, params) => {
    // Guard: feature flag check
    const disabledResponse = checkMemoryEnabled();
    if (disabledResponse !== null) return disabledResponse;

    // Guard: circuit breaker state check
    const openResponse = checkCircuitBreaker(breaker);
    if (openResponse !== null) return openResponse;

    // Guard: workspaceId validation
    const validationError = validateWorkspaceId(req);
    if (validationError !== null) return validationError;

    // Parse id param from URL
    const id = params.id;
    if (!id || id.trim() === '') {
      return jsonResponse({ error: 'id required' }, 400);
    }

    try {
      // Call client.delete with the parsed id
      await client.delete(id);

      // Return 204 on success (no content)
      return new Response(null, { status: 204 });
    } catch (err) {
      // Check if the error indicates memory not found
      if (err instanceof MemoryClientError && err.statusCode === 404) {
        return jsonResponse({ error: 'not found' }, 404);
      }

      // Map other errors to HTTP status codes per error mapping table
      return mapMemoryError(err);
    }
  });

  // POST /api/memory/reflect
  router.post('/api/memory/reflect', async (req, _params) => {
    // Guard: feature flag check
    const disabledResponse = checkMemoryEnabled();
    if (disabledResponse !== null) return disabledResponse;

    // Guard: circuit breaker state check
    const openResponse = checkCircuitBreaker(breaker);
    if (openResponse !== null) return openResponse;

    // Parse request body
    let body: { topic?: string; workspaceId?: string };
    try {
      body = await req.json();
    } catch (err) {
      return jsonResponse({ error: 'invalid JSON body' }, 400);
    }

    // Validate topic field
    if (typeof body.topic !== 'string' || body.topic.trim() === '') {
      return jsonResponse({ error: 'topic field is required and must be a non-empty string' }, 400);
    }

    // Validate workspaceId field
    if (typeof body.workspaceId !== 'string' || body.workspaceId.trim() === '') {
      return jsonResponse({ error: 'workspaceId required' }, 400);
    }

    try {
      // Call client.reflect with topic and scope
      // Requirement 1.6: POST /api/memory/reflect accepts { topic, workspaceId } and calls client.reflect
      const reflection = await client.reflect(body.topic, { workspaceId: body.workspaceId });

      // Return { reflection: string | null }
      return jsonResponse({ reflection });
    } catch (err) {
      // Map errors to HTTP status codes per error mapping table
      return mapMemoryError(err);
    }
  });
}
