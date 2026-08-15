// src/routes/memory.ts
// Route handlers for memory infrastructure: GET /api/memory/circuit-breaker
//
// When MEMORY_ENABLED=false the route returns { state: 'disabled' } so callers
// can always query the endpoint regardless of the feature flag state.

import type { Router } from '../router.ts';
import { MEMORY_ENABLED } from '../constants.ts';
import type { MemoryCircuitBreaker } from '../memory/circuit-breaker.ts';
import type { CircuitBreakerMetrics } from '../memory/types.ts';

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
      return new Response(JSON.stringify(disabled), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // MEMORY_ENABLED=true: circuitBreaker is guaranteed non-null when the
    // factory in client.ts constructed it.  The non-null assertion is safe
    // because monitor.ts passes the breaker when registering this route.
    const metrics: CircuitBreakerMetrics = circuitBreaker!.getMetrics();
    return new Response(JSON.stringify(metrics), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}
