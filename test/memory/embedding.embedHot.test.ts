/**
 * Unit tests for `embedHot` in `src/memory/embedding.ts`.
 *
 * Covers (sub-task 4.6):
 *   - Empty VOYAGE_API_KEY → returns null without calling fetch
 *   - Voyage API returns non-200 status → returns null
 *   - fetch times out (AbortSignal timeout DOMException) → returns null
 *
 * Strategy:
 *   - "Empty key" test: mock.module() overrides constants.ts so the module-
 *     level VOYAGE_API_KEY import resolves to '' when embedHot is freshly
 *     imported via dynamic import after the mock is registered.
 *   - "Non-200" and "Timeout" tests: VOYAGE_API_KEY is set to a real-looking
 *     value by mutating the constants module mock, and global fetch is replaced
 *     with a controlled fake for the duration of each test.
 *
 * Requirements: Phase 6.2, Requirement 3 AC 4 (hot-tier Voyage call), AC 5
 * (cold-tier never calls Voyage).
 */

import { describe, it, expect, mock, beforeAll, afterAll } from 'bun:test';

// ---------------------------------------------------------------------------
// Constants mock factories
// ---------------------------------------------------------------------------

/** All constants with VOYAGE_API_KEY set to empty string (key absent). */
function makeConstantsMockNoKey(): Record<string, unknown> {
  return {
    resolveConstants: () => ({}),
    PORT: 3333,
    POLL_LOG_MAX: 200,
    SCAN_CACHE_TTL: 5000,
    SHUTDOWN_TIMEOUT_MS: 5000,
    OUTPUT_DIR: '',
    SESSIONS_DIR: '',
    CHAINS_DIR: '',
    WORKFLOW_DIR: '',
    WORKSPACE_ROOT: '',
    SPECS_DIR: '',
    PROMPT_OUTPUT_DIR: '',
    CRAWL_JOBS_FILE: 'docs/reference/.crawl-queue.json',
    CLONE_JOBS_FILE: 'docs/reference/.clone-queue.json',
    BUILD_QUEUE_FILE: 'docs/reference/.build-queue.json',
    KIRO_TOOLS_DIR: '',
    MEMORY_ENABLED: false,
    HINDSIGHT_URL: 'http://localhost:3100',
    MEMORY_EXTRACTION_ENABLED: false,
    MEMORY_AUTO_INJECT: false,
    MEMORY_MAX_CONTEXT_MEMORIES: 10,
    MEMORY_CONTEXT_TOKEN_BUDGET: 2000,
    MEMORY_DECAY_DAYS: 90,
    MEMORY_RETRY_PATH: 'data/memory-retry-queue.jsonl',
    VOYAGE_API_KEY: '',
    MEMORY_HOT_TIER_COUNT: 100,
  };
}

/** All constants with VOYAGE_API_KEY set to a non-empty test value. */
function makeConstantsMockWithKey(): Record<string, unknown> {
  return {
    ...makeConstantsMockNoKey(),
    VOYAGE_API_KEY: 'test-voyage-key-abc123',
  };
}

// ---------------------------------------------------------------------------
// Test 1 — Empty API key → null without fetch
//
// mock.module() must be registered before the dynamic import of embedding.ts
// so that the live ES module binding picks up the empty VOYAGE_API_KEY value.
// ---------------------------------------------------------------------------

describe('embedHot — empty VOYAGE_API_KEY returns null without fetch', () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    // Register the no-key constants mock before importing embedding.ts
    mock.module('../../src/constants.ts', () => makeConstantsMockNoKey());
  });

  afterAll(() => {
    // Restore fetch in case it was replaced (it should not be for this test)
    globalThis.fetch = originalFetch;
  });

  it('should return null and never call fetch when VOYAGE_API_KEY is empty', async () => {
    // Arrange — track whether fetch is called
    const fetchSpy = mock(() => Promise.resolve(new Response('', { status: 200 })));
    (globalThis as Record<string, unknown>).fetch = fetchSpy;

    // Import embedHot after the module mock is in place
    const { embedHot } = await import('../../src/memory/embedding.ts');

    // Act
    const result = await embedHot('some memory fact text for testing');

    // Assert
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 2 & 3 — fetch-dependent cases
//
// mock.module() sets a real-looking VOYAGE_API_KEY so embedHot proceeds past
// the key guard and reaches the fetch call.
// ---------------------------------------------------------------------------

describe('embedHot — with VOYAGE_API_KEY set', () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    // Register with a valid-looking API key so embedHot reaches the fetch call
    mock.module('../../src/constants.ts', () => makeConstantsMockWithKey());
  });

  afterAll(() => {
    // Restore original fetch after all tests in this describe block
    globalThis.fetch = originalFetch;
  });

  it('should return null when the Voyage API returns a non-200 status', async () => {
    // Arrange — Voyage returns HTTP 429 (rate limit)
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'rate limit exceeded' }), { status: 429 }),
      ),
    );
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    const { embedHot } = await import('../../src/memory/embedding.ts');

    // Act
    const result = await embedHot('some memory fact text for testing');

    // Assert
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should return null when fetch throws a timeout DOMException', async () => {
    // Arrange — simulate AbortSignal.timeout firing: fetch throws DOMException
    const timeoutError = new DOMException('The operation was aborted.', 'TimeoutError');
    const mockFetch = mock(() => Promise.reject(timeoutError));
    (globalThis as Record<string, unknown>).fetch = mockFetch;

    const { embedHot } = await import('../../src/memory/embedding.ts');

    // Act
    const result = await embedHot('some memory fact text for testing');

    // Assert
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
