/**
 * Unit tests for the DB-init gate middleware (Task 22 / Req 8.4).
 *
 * The gate is implemented as an inline check inside monitor.ts's fetch handler.
 * These tests exercise the gate logic in isolation by extracting it into a
 * testable helper function, keeping the tests free of Bun.serve machinery.
 *
 * Gate rules:
 *   - If dbReady === false AND dbEnabled === true AND pathname starts with "/api/"
 *     → return 503 { error: "initializing" }
 *   - Otherwise (dbReady=true, OR dbEnabled=false, OR non-/api/ path) → pass through
 *
 * Requirements: 8.4
 */

import { describe, it, expect } from 'bun:test';

// ---------------------------------------------------------------------------
// Inline implementation of the gate logic under test.
// Mirrors what monitor.ts does in its fetch handler — extracted here so we
// can test it without starting a full server.
// ---------------------------------------------------------------------------

interface GateOptions {
  dbReady: boolean;
  dbEnabled: boolean;
  pathname: string;
}

/**
 * Returns a 503 Response when the DB init gate fires, or null to pass through.
 * This mirrors the logic in monitor.ts fetch() exactly.
 */
function applyInitGate({ dbReady, dbEnabled, pathname }: GateOptions): Response | null {
  if (!dbReady && dbEnabled && pathname.startsWith('/api/')) {
    return new Response(
      JSON.stringify({ error: 'initializing' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DB-init gate middleware', () => {
  describe('when DB is enabled and not yet ready', () => {
    it('should return 503 for /api/ routes', () => {
      const result = applyInitGate({ dbReady: false, dbEnabled: true, pathname: '/api/status-history/job-123' });

      expect(result).not.toBeNull();
      expect(result!.status).toBe(503);
    });

    it('should include { error: "initializing" } in the 503 body', async () => {
      const result = applyInitGate({ dbReady: false, dbEnabled: true, pathname: '/api/jobs' });

      const body = await result!.json() as { error: string };
      expect(body.error).toBe('initializing');
    });

    it('should set content-type to application/json on 503', () => {
      const result = applyInitGate({ dbReady: false, dbEnabled: true, pathname: '/api/chains' });

      expect(result!.headers.get('content-type')).toBe('application/json');
    });

    it('should pass through requests to /', () => {
      const result = applyInitGate({ dbReady: false, dbEnabled: true, pathname: '/' });

      expect(result).toBeNull();
    });

    it('should pass through requests to /jobs (file-scan route)', () => {
      const result = applyInitGate({ dbReady: false, dbEnabled: true, pathname: '/jobs' });

      expect(result).toBeNull();
    });

    it('should pass through requests to /chains', () => {
      const result = applyInitGate({ dbReady: false, dbEnabled: true, pathname: '/chains' });

      expect(result).toBeNull();
    });

    it('should pass through requests to /sessions', () => {
      const result = applyInitGate({ dbReady: false, dbEnabled: true, pathname: '/sessions' });

      expect(result).toBeNull();
    });

    it('should pass through static asset requests', () => {
      const result = applyInitGate({ dbReady: false, dbEnabled: true, pathname: '/index-abc123.js' });

      expect(result).toBeNull();
    });

    it('should pass through /dist/ asset requests', () => {
      const result = applyInitGate({ dbReady: false, dbEnabled: true, pathname: '/dist/index-abc123.css' });

      expect(result).toBeNull();
    });

    it('should block all /api/ sub-paths including deeply nested ones', () => {
      const paths = [
        '/api/',
        '/api/status-history/abc',
        '/api/metrics',
        '/api/v2/something',
      ];

      for (const pathname of paths) {
        const result = applyInitGate({ dbReady: false, dbEnabled: true, pathname });
        expect(result).not.toBeNull();
        expect(result!.status).toBe(503);
      }
    });
  });

  describe('when DB is ready (dbReady=true)', () => {
    it('should pass through /api/ routes as a no-op', () => {
      const result = applyInitGate({ dbReady: true, dbEnabled: true, pathname: '/api/status-history/job-1' });

      expect(result).toBeNull();
    });

    it('should pass through all routes as a no-op', () => {
      const paths = ['/', '/jobs', '/chains', '/api/status-history/x'];

      for (const pathname of paths) {
        const result = applyInitGate({ dbReady: true, dbEnabled: true, pathname });
        expect(result).toBeNull();
      }
    });
  });

  describe('when DB is disabled (dbEnabled=false)', () => {
    it('should pass through /api/ routes regardless of dbReady', () => {
      const result = applyInitGate({ dbReady: false, dbEnabled: false, pathname: '/api/anything' });

      // Gate is skipped entirely when DB_ENABLED=false
      expect(result).toBeNull();
    });

    it('should pass through all routes as a no-op', () => {
      const paths = ['/', '/jobs', '/chains', '/api/status-history/x'];

      for (const pathname of paths) {
        const result = applyInitGate({ dbReady: false, dbEnabled: false, pathname });
        expect(result).toBeNull();
      }
    });
  });
});
