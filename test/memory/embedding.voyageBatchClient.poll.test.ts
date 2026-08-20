/**
 * Unit tests for `VoyageBatchClient.poll` in `src/memory/embedding.ts`.
 *
 * Covers (sub-task 4.7):
 *   - Timeout exceeded → poll rejects with a timeout error
 *   - Success → returns BatchResult with correct embeddings and failed indices
 *
 * Strategy:
 *   VoyageBatchClient is instantiated directly with a fake API key and a
 *   configurable base URL. Global fetch is replaced per-test with a controlled
 *   mock. No module-level mocking of constants is needed because the constructor
 *   accepts the API key as a parameter.
 *
 *   Timeout tests use a very small timeoutMs so that the polling loop exits
 *   quickly without real timers. The mock fetch returns 'processing' status,
 *   forcing the loop to exhaust the deadline.
 *
 *   Success tests return { status: 'completed', data, failed_indices } on the
 *   first poll, so the loop exits immediately.
 *
 * Requirements: Phase 6.2, Requirement 3 AC 6–9 (batch worker / poll contract).
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { VoyageBatchClient } from '../../src/memory/embedding.ts';
import type { BatchResult } from '../../src/memory/embedding.ts';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const FAKE_API_KEY = 'test-voyage-key-poll-suite';
const FAKE_BASE_URL = 'https://fake.voyageai.test/v1';
const BATCH_ID = 'batch-poll-001';

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

/**
 * Build a fetch mock that always returns `{ status: 'processing' }`.
 * Used to force the poll loop to run until the deadline is exceeded.
 */
function makeProcessingFetch(): ReturnType<typeof mock> {
  return mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ status: 'processing' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

/**
 * Build a fetch mock that returns a completed batch result on the first call.
 *
 * @param embeddings Parallel embedding vectors to return.
 * @param failedIndices 0-based indices of texts that failed embedding.
 */
function makeCompletedFetch(
  embeddings: number[][],
  failedIndices: number[],
): ReturnType<typeof mock> {
  return mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          status: 'completed',
          data: embeddings.map(embedding => ({ embedding })),
          failed_indices: failedIndices,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    ),
  );
}

/**
 * Build a fetch mock that returns a terminal `failed` status.
 * Triggers the Voyage-side failure branch in poll().
 */
function makeFailedBatchFetch(): ReturnType<typeof mock> {
  return mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ status: 'failed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

/**
 * Build a fetch mock that returns HTTP 500 on every call.
 */
function makeHttp500Fetch(): ReturnType<typeof mock> {
  return mock(() =>
    Promise.resolve(
      new Response('Internal Server Error', { status: 500 }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('VoyageBatchClient.poll', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Ensure each test starts with a clean fetch reference
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Timeout path
  // -------------------------------------------------------------------------

  describe('timeout exceeded → rejects', () => {
    it('should reject with a timeout error when polling does not complete within timeoutMs', async () => {
      // Arrange — fetch always returns 'processing'; timeoutMs is 1 ms so the
      // deadline is exceeded before the loop can poll again.
      const mockFetch = makeProcessingFetch();
      (globalThis as Record<string, unknown>).fetch = mockFetch;

      const client = new VoyageBatchClient(FAKE_API_KEY, FAKE_BASE_URL);

      // Act + Assert — poll must reject
      await expect(client.poll(BATCH_ID, 1)).rejects.toThrow();
    });

    it('should include the batch ID and timeout duration in the rejection message', async () => {
      // Arrange
      const mockFetch = makeProcessingFetch();
      (globalThis as Record<string, unknown>).fetch = mockFetch;

      const client = new VoyageBatchClient(FAKE_API_KEY, FAKE_BASE_URL);

      // Act + Assert — error message carries contextual info
      let caughtError: unknown;
      try {
        await client.poll(BATCH_ID, 1);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(Error);
      const message = (caughtError as Error).message;
      expect(message).toContain(BATCH_ID);
      expect(message).toContain('1');
    });

    it('should reject with a descriptive error when the Voyage batch job itself fails', async () => {
      // Arrange — Voyage returns terminal 'failed' status
      const mockFetch = makeFailedBatchFetch();
      (globalThis as Record<string, unknown>).fetch = mockFetch;

      const client = new VoyageBatchClient(FAKE_API_KEY, FAKE_BASE_URL);

      // Act + Assert
      await expect(client.poll(BATCH_ID, 60_000)).rejects.toThrow(BATCH_ID);
    });

    it('should reject when the Voyage poll endpoint returns a non-200 HTTP status', async () => {
      // Arrange — server error on every poll attempt
      const mockFetch = makeHttp500Fetch();
      (globalThis as Record<string, unknown>).fetch = mockFetch;

      const client = new VoyageBatchClient(FAKE_API_KEY, FAKE_BASE_URL);

      // Act + Assert — non-200 throws immediately (does not loop until timeout)
      await expect(client.poll(BATCH_ID, 60_000)).rejects.toThrow('500');
    });
  });

  // -------------------------------------------------------------------------
  // Success path
  // -------------------------------------------------------------------------

  describe('success → returns BatchResult with correct failed indices', () => {
    it('should return BatchResult with embeddings and empty failed array when all succeed', async () => {
      // Arrange — two texts, both succeed
      const embeddings = [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ];
      const mockFetch = makeCompletedFetch(embeddings, []);
      (globalThis as Record<string, unknown>).fetch = mockFetch;

      const client = new VoyageBatchClient(FAKE_API_KEY, FAKE_BASE_URL);

      // Act
      const result: BatchResult = await client.poll(BATCH_ID, 60_000);

      // Assert — embeddings returned verbatim; no failures
      expect(result.embeddings).toEqual(embeddings);
      expect(result.failed).toEqual([]);
    });

    it('should return failed indices matching the indices from Voyage failed_indices field', async () => {
      // Arrange — three texts; index 1 fails on the Voyage side
      const embeddings = [
        [1.0, 2.0],
        [],          // failed — Voyage returns empty or omits for failed items
        [3.0, 4.0],
      ];
      const failedIndices = [1];
      const mockFetch = makeCompletedFetch(embeddings, failedIndices);
      (globalThis as Record<string, unknown>).fetch = mockFetch;

      const client = new VoyageBatchClient(FAKE_API_KEY, FAKE_BASE_URL);

      // Act
      const result: BatchResult = await client.poll(BATCH_ID, 60_000);

      // Assert — failed contains exactly [1]
      expect(result.failed).toEqual([1]);
      expect(result.failed).toHaveLength(1);
      // Successful embeddings still present
      expect(result.embeddings[0]).toEqual([1.0, 2.0]);
      expect(result.embeddings[2]).toEqual([3.0, 4.0]);
    });

    it('should return multiple failed indices when several texts fail', async () => {
      // Arrange — four texts; indices 0 and 3 fail
      const embeddings = [[], [7.0, 8.0], [9.0, 10.0], []];
      const failedIndices = [0, 3];
      const mockFetch = makeCompletedFetch(embeddings, failedIndices);
      (globalThis as Record<string, unknown>).fetch = mockFetch;

      const client = new VoyageBatchClient(FAKE_API_KEY, FAKE_BASE_URL);

      // Act
      const result: BatchResult = await client.poll(BATCH_ID, 60_000);

      // Assert
      expect(result.failed).toEqual([0, 3]);
      expect(result.failed).toHaveLength(2);
      expect(result.embeddings[1]).toEqual([7.0, 8.0]);
      expect(result.embeddings[2]).toEqual([9.0, 10.0]);
    });

    it('should return all indices as failed when every text fails', async () => {
      // Arrange — two texts, both fail
      const embeddings = [[], []];
      const failedIndices = [0, 1];
      const mockFetch = makeCompletedFetch(embeddings, failedIndices);
      (globalThis as Record<string, unknown>).fetch = mockFetch;

      const client = new VoyageBatchClient(FAKE_API_KEY, FAKE_BASE_URL);

      // Act
      const result: BatchResult = await client.poll(BATCH_ID, 60_000);

      // Assert
      expect(result.failed).toEqual([0, 1]);
      expect(result.embeddings).toHaveLength(2);
    });

    it('should resolve on the first poll response when the batch is already completed', async () => {
      // Arrange — 'completed' on first call; track call count
      const embeddings = [[0.9, 0.8, 0.7]];
      const mockFetch = makeCompletedFetch(embeddings, []);
      (globalThis as Record<string, unknown>).fetch = mockFetch;

      const client = new VoyageBatchClient(FAKE_API_KEY, FAKE_BASE_URL);

      // Act
      const result: BatchResult = await client.poll(BATCH_ID, 60_000);

      // Assert — only one fetch call made (resolved immediately, no re-poll)
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.embeddings).toEqual(embeddings);
    });

    it('should use the correct poll URL constructed from baseUrl and batchId', async () => {
      // Arrange — capture the URL passed to fetch
      let capturedUrl: string | undefined;
      const mockFetch = mock((url: unknown) => {
        capturedUrl = String(url);
        return Promise.resolve(
          new Response(
            JSON.stringify({ status: 'completed', data: [{ embedding: [1.0] }], failed_indices: [] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      });
      (globalThis as Record<string, unknown>).fetch = mockFetch;

      const client = new VoyageBatchClient(FAKE_API_KEY, FAKE_BASE_URL);

      // Act
      await client.poll(BATCH_ID, 60_000);

      // Assert — URL follows the pattern {baseUrl}/batch/embeddings/{batchId}
      expect(capturedUrl).toBe(`${FAKE_BASE_URL}/batch/embeddings/${BATCH_ID}`);
    });

    it('should include the Authorization header with Bearer token on every poll request', async () => {
      // Arrange — capture request init
      let capturedInit: RequestInit | undefined;
      const mockFetch = mock((_url: unknown, init: unknown) => {
        capturedInit = init as RequestInit;
        return Promise.resolve(
          new Response(
            JSON.stringify({ status: 'completed', data: [{ embedding: [1.0] }], failed_indices: [] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      });
      (globalThis as Record<string, unknown>).fetch = mockFetch;

      const client = new VoyageBatchClient(FAKE_API_KEY, FAKE_BASE_URL);

      // Act
      await client.poll(BATCH_ID, 60_000);

      // Assert — Authorization header present and correctly formatted
      const headers = capturedInit?.headers as Record<string, string> | undefined;
      expect(headers?.['Authorization']).toBe(`Bearer ${FAKE_API_KEY}`);
    });

    it('should handle an empty data array from Voyage gracefully (no embeddings, no failures)', async () => {
      // Arrange — completed with no data (edge case: empty batch)
      const mockFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ status: 'completed' }), // no data, no failed_indices
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      );
      (globalThis as Record<string, unknown>).fetch = mockFetch;

      const client = new VoyageBatchClient(FAKE_API_KEY, FAKE_BASE_URL);

      // Act
      const result: BatchResult = await client.poll(BATCH_ID, 60_000);

      // Assert — defaults to empty arrays, does not throw
      expect(result.embeddings).toEqual([]);
      expect(result.failed).toEqual([]);
    });
  });
});
