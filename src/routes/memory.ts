// src/routes/memory.ts
// Route handlers for memory infrastructure: GET /api/memory/circuit-breaker
//
// When MEMORY_ENABLED=false the route returns { state: 'disabled' } so callers
// can always query the endpoint regardless of the feature flag state.

import type { Router } from '../router.ts';
import {
  MEMORY_ENABLED,
  MEMORY_MAX_CONTEXT_MEMORIES,
  MEMORY_CONTEXT_TOKEN_BUDGET,
} from '../constants.ts';
import type { MemoryCircuitBreaker } from '../memory/circuit-breaker.ts';
import type { CircuitBreakerMetrics, IMemoryClient, Memory } from '../memory/types.ts';
import {
  ReadOnlyMemoryClient,
  assembleContext,
  type MemoryAssemblyConfig,
  type MemoryFate,
} from '../memory/assembly.ts';
import { scopeFromJob } from '../memory/scopes.ts';
import { scanJobs } from '../scan/jobs.ts';
import type { Job } from '../types.ts';

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/**
 * Response from POST /api/memory/inject-test diagnostic endpoint.
 */
export type InjectTestResponse = {
  memoryCount: number;       // memories included in budget
  tokenCount: number;        // total tokens consumed by the assembled block
  memories: Memory[];        // full Memory objects included
  dropped: number;           // count of candidates that exceeded budget
  circuitState: string;      // MemoryCircuitBreaker.getMetrics().state
  assemblyMs: number;        // wall-clock time for recall + token-budget pass
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a JSON Response with consistent headers.
 */
function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Register memory routes on the given router.
 *
 * @param router         - Application router instance.
 * @param circuitBreaker - The shared MemoryCircuitBreaker instance, or null
 *                         when MEMORY_ENABLED=false.  The handler never
 *                         constructs its own breaker — it uses this reference.
 */
export function register(
  router: Router,
  circuitBreaker: MemoryCircuitBreaker | null,
): void {
  // GET /api/memory/circuit-breaker — current circuit breaker state / metrics
  router.get('/api/memory/circuit-breaker', (_req, _params) => {
    if (!MEMORY_ENABLED) {
      const disabled: Pick<CircuitBreakerMetrics, 'state'> = { state: 'disabled' };
      return jsonResponse(disabled);
    }

    // MEMORY_ENABLED=true: circuitBreaker is guaranteed non-null when the
    // factory in client.ts constructed it.  The non-null assertion is safe
    // because monitor.ts passes the breaker when registering this route.
    const metrics: CircuitBreakerMetrics = circuitBreaker!.getMetrics();
    return jsonResponse(metrics);
  });

  // POST /api/memory/inject-test — diagnostic endpoint for context assembly
  router.post('/api/memory/inject-test', async (req, _params) => {
    // Guard 1: Feature flag check
    if (!MEMORY_ENABLED) {
      return jsonResponse({ error: 'memory is not enabled' }, 503);
    }

    // Guard 2: Parse request body
    let body: { jobId?: string };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: 'malformed request body' }, 400);
    }

    const { jobId } = body;
    if (typeof jobId !== 'string' || jobId.length === 0) {
      return jsonResponse({ error: 'jobId is required' }, 400);
    }

    // Guard 3: Look up job from scan cache
    const jobs = await scanJobs();
    const job = jobs.find(j => j.id === jobId);
    if (job === undefined) {
      return jsonResponse({ error: 'job not found', jobId }, 404);
    }

    // Guard 4: Check job status
    if (job.status === 'running' || job.status === 'error') {
      return jsonResponse(
        { error: 'job is not in a completed state', status: job.status },
        400
      );
    }

    // Wrap circuit breaker in read-only client
    // circuitBreaker is guaranteed non-null when MEMORY_ENABLED=true
    const readOnlyClient = new ReadOnlyMemoryClient(circuitBreaker!);

    // Prepare assembly config
    const config: MemoryAssemblyConfig = {
      candidateLimit: MEMORY_MAX_CONTEXT_MEMORIES * 2,
      tokenBudget: MEMORY_CONTEXT_TOKEN_BUDGET,
    };

    // Track included and dropped memories via collector
    const included: Memory[] = [];
    let dropped = 0;

    const collector = (memory: Memory, fate: MemoryFate): void => {
      if (fate === 'included') {
        included.push(memory);
      } else {
        dropped += 1;
      }
    };

    // Run assembly with timing
    const startMs = Date.now();
    const result = await assembleContext(job, readOnlyClient, config, collector);
    const assemblyMs = Date.now() - startMs;

    // Count tokens
    const tokenCount = Math.ceil(result.length / 4);

    // Get circuit state
    const circuitState = circuitBreaker!.getMetrics().state;

    // Return diagnostic response
    const response: InjectTestResponse = {
      memoryCount: included.length,
      tokenCount,
      memories: included,
      dropped,
      circuitState,
      assemblyMs,
    };

    return jsonResponse(response, 200);
  });
}
