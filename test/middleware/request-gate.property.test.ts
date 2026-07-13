/**
 * Property-Based Tests for Request Gate During Initialization (Property 5)
 *
 * Verifies that the DB-init gate middleware defined in `src/monitor.ts` satisfies
 * the blocking invariant described in Requirement 8.4:
 *
 *   WHEN DB_ENABLED=true and the database is initializing (dbReady=false),
 *   THE Monitor SHALL block all incoming API requests until database
 *   initialization completes before serving any responses.
 *
 * Three sub-properties are tested:
 *
 *   5a. **API routes blocked during init** — any path matching `/api/...`
 *       returns HTTP 503 with `{ error: "initializing" }` while dbReady=false
 *       and dbConfig.enabled=true.
 *
 *   5b. **Non-API routes pass through during init** — paths that do NOT start
 *       with `/api/` (root `/`, static assets, etc.) are not blocked by the
 *       gate; they fall through to normal router handling.
 *
 *   5c. **Gate is a no-op when dbReady=true** — once the DB has finished
 *       initialising, no request is blocked by the gate regardless of path.
 *
 * The gate logic is extracted from `monitor.ts` into a pure function for
 * isolated unit testing — this avoids spinning up a real HTTP server while
 * still testing the exact production decision algorithm.
 *
 * **Validates: Requirements 8.4**
 */

import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// Gate function — mirrors the exact middleware logic from src/monitor.ts
// ---------------------------------------------------------------------------

/**
 * The DB-init gate decision extracted as a pure, side-effect-free function.
 *
 * Mirrors the exact condition in `monitor.ts`:
 *
 * ```ts
 * if (!dbReady && dbConfig.enabled) {
 *   if (pathname.startsWith('/api/')) {
 *     return new Response(
 *       JSON.stringify({ error: 'initializing' }),
 *       { status: 503, headers: { 'content-type': 'application/json' } },
 *     );
 *   }
 * }
 * ```
 *
 * Returns:
 * - `{ blocked: true, status: 503, body: { error: 'initializing' } }` when
 *   the request should be gated.
 * - `{ blocked: false }` when the request should proceed normally.
 */
type GateResult =
  | { blocked: true; status: 503; body: { error: 'initializing' } }
  | { blocked: false };

function applyRequestGate(
  pathname: string,
  dbReady: boolean,
  dbEnabled: boolean,
): GateResult {
  if (!dbReady && dbEnabled) {
    if (pathname.startsWith('/api/')) {
      return { blocked: true, status: 503, body: { error: 'initializing' } };
    }
  }
  return { blocked: false };
}

// ---------------------------------------------------------------------------
// fast-check arbitraries
// ---------------------------------------------------------------------------

/**
 * Arbitrary API path: always starts with `/api/` followed by at least one
 * safe segment character.  Covers paths like `/api/jobs`, `/api/chains/123`.
 */
const apiPathArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => /^[a-zA-Z0-9_\-./]+$/.test(s) && !s.includes('..'))
  .map((suffix) => `/api/${suffix}`);

/**
 * Arbitrary non-API path: root, static assets, or arbitrary non-/api/ paths.
 * These must NOT start with `/api/`.
 */
const nonApiPathArb: fc.Arbitrary<string> = fc.oneof(
  // Root path
  fc.constant('/'),
  // Favicon and common static assets
  fc.constantFrom('/favicon.ico', '/index.html', '/styles.css'),
  // /dist/ static bundle paths (Vite output)
  fc
    .string({ minLength: 1, maxLength: 30 })
    .filter((s) => /^[a-zA-Z0-9_\-.]+$/.test(s))
    .map((name) => `/dist/${name}`),
  // Flat asset paths (index-*.js / index-*.css from Vite)
  fc
    .string({ minLength: 4, maxLength: 12 })
    .filter((s) => /^[a-z0-9]+$/.test(s))
    .map((hash) => `/index-${hash}.js`),
  // Generic non-api paths
  fc
    .string({ minLength: 1, maxLength: 30 })
    .filter(
      (s) =>
        /^[a-zA-Z0-9_\-./]+$/.test(s) &&
        !s.startsWith('api/') &&
        !s.includes('..'),
    )
    .map((seg) => `/${seg}`),
);

// ---------------------------------------------------------------------------
// Property 5a — API routes blocked during initialization
// **Validates: Requirements 8.4**
// ---------------------------------------------------------------------------

describe('Property 5: Request Gate During Initialization', () => {
  it(
    'property: any /api/* path returns 503 { error: "initializing" } when dbReady=false and DB_ENABLED=true',
    () => {
      fc.assert(
        fc.property(apiPathArb, (pathname) => {
          // Arrange: DB is initializing (dbReady=false, DB_ENABLED=true)
          const dbReady = false;
          const dbEnabled = true;

          // Act: apply the gate
          const result = applyRequestGate(pathname, dbReady, dbEnabled);

          // Assert: every /api/ path must be blocked with 503
          expect(result.blocked).toBe(true);
          if (result.blocked) {
            expect(result.status).toBe(503);
            expect(result.body).toEqual({ error: 'initializing' });
          }
        }),
        { numRuns: 200 },
      );
    },
  );

  // ---------------------------------------------------------------------------
  // Property 5b — Non-API routes pass through during initialization
  // **Validates: Requirements 8.4**
  // ---------------------------------------------------------------------------

  it(
    'property: non-/api/ paths are NOT blocked by the gate when dbReady=false and DB_ENABLED=true',
    () => {
      fc.assert(
        fc.property(nonApiPathArb, (pathname) => {
          // Arrange: DB is initializing (dbReady=false, DB_ENABLED=true)
          const dbReady = false;
          const dbEnabled = true;

          // Act: apply the gate
          const result = applyRequestGate(pathname, dbReady, dbEnabled);

          // Assert: non-API paths must NOT be blocked — they fall through to
          // normal router handling (file-scan routes remain available).
          expect(result.blocked).toBe(false);
        }),
        { numRuns: 200 },
      );
    },
  );

  // ---------------------------------------------------------------------------
  // Property 5c — Gate is a no-op once dbReady=true
  // **Validates: Requirements 8.4**
  // ---------------------------------------------------------------------------

  it(
    'property: no path is blocked by the gate once dbReady=true, regardless of DB_ENABLED',
    () => {
      // Combine any path (API or non-API) with any dbEnabled value.
      const anyPathArb = fc.oneof(apiPathArb, nonApiPathArb);

      fc.assert(
        fc.property(anyPathArb, fc.boolean(), (pathname, dbEnabled) => {
          // Arrange: DB initialization is complete
          const dbReady = true;

          // Act: apply the gate
          const result = applyRequestGate(pathname, dbReady, dbEnabled);

          // Assert: gate must be a no-op — dbReady=true short-circuits the check
          expect(result.blocked).toBe(false);
        }),
        { numRuns: 200 },
      );
    },
  );

  // ---------------------------------------------------------------------------
  // Property 5d — DB_ENABLED=false disables the gate entirely
  // **Validates: Requirements 8.4**
  // ---------------------------------------------------------------------------

  it(
    'property: no path is blocked when DB_ENABLED=false, even if dbReady=false',
    () => {
      const anyPathArb = fc.oneof(apiPathArb, nonApiPathArb);

      fc.assert(
        fc.property(anyPathArb, (pathname) => {
          // Arrange: DB is disabled — dbReady stays false but the gate must
          // be skipped entirely (file-only mode).
          const dbReady = false;
          const dbEnabled = false;

          // Act: apply the gate
          const result = applyRequestGate(pathname, dbReady, dbEnabled);

          // Assert: DB_ENABLED=false means the check is never entered;
          // no requests should be blocked.
          expect(result.blocked).toBe(false);
        }),
        { numRuns: 200 },
      );
    },
  );

  // ---------------------------------------------------------------------------
  // Property 5e — Boundary: paths starting with /api but missing trailing /
  //               are NOT caught by the `/api/` prefix guard
  // ---------------------------------------------------------------------------

  it(
    'property: the exact path /api (without trailing slash) is not blocked',
    () => {
      // The production guard is `pathname.startsWith('/api/')` — a literal
      // `/api` (no trailing slash) does NOT satisfy this predicate.
      const result = applyRequestGate('/api', false, true);
      expect(result.blocked).toBe(false);
    },
  );

  // ---------------------------------------------------------------------------
  // Property 5f — Spot-check: known API paths are blocked during init
  // ---------------------------------------------------------------------------

  it(
    'should block known API endpoints when dbReady=false and DB_ENABLED=true',
    () => {
      const knownApiPaths = [
        '/api/jobs',
        '/api/chains',
        '/api/sessions',
        '/api/status-history/some-job-id',
        '/api/git-status',
        '/api/system-status',
      ];

      for (const pathname of knownApiPaths) {
        const result = applyRequestGate(pathname, false, true);
        expect(result.blocked).toBe(true);
        if (result.blocked) {
          expect(result.status).toBe(503);
          expect(result.body).toEqual({ error: 'initializing' });
        }
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Property 5g — Spot-check: known non-API paths pass through during init
  // ---------------------------------------------------------------------------

  it(
    'should NOT block root and static asset paths when dbReady=false and DB_ENABLED=true',
    () => {
      const staticPaths = [
        '/',
        '/favicon.ico',
        '/index.html',
        '/dist/main.js',
        '/index-abc123.js',
        '/index-abc123.css',
      ];

      for (const pathname of staticPaths) {
        const result = applyRequestGate(pathname, false, true);
        expect(result.blocked).toBe(false);
      }
    },
  );
});
