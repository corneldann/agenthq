// ---------------------------------------------------------------------------
// Memory embedding — hot/cold tier classification and Voyage API wrappers.
//
// Exports:
//   classifyTier(db, workspaceId) → 'hot' | 'cold'
//   embedHot(text)                → number[] | null
//   VoyageBatchClient             — Voyage Batch API wrapper class
// ---------------------------------------------------------------------------

import type { DbAdapter } from '../db/adapter.ts';
import { VOYAGE_API_KEY, MEMORY_HOT_TIER_COUNT } from '../constants.ts';

// ---------------------------------------------------------------------------
// BatchResult — returned by VoyageBatchClient.poll
// ---------------------------------------------------------------------------

export type BatchResult = {
  /** Parallel array of embedding vectors, one per submitted text. */
  embeddings: number[][];
  /** Indices (0-based) of texts whose embedding failed in the Voyage batch. */
  failed: number[];
};

// ---------------------------------------------------------------------------
// classifyTier
// ---------------------------------------------------------------------------

/**
 * Classify the embedding tier for the next extraction in the given workspace.
 *
 * The tier is `'hot'` if the total count of non-deleted completed jobs in the
 * workspace (statuses: `done`, `reported`, `error`) is less than
 * `MEMORY_HOT_TIER_COUNT`; otherwise `'cold'`.
 *
 * The query uses `ORDER BY timestamp DESC LIMIT MEMORY_HOT_TIER_COUNT` to keep
 * the scan bounded at O(MEMORY_HOT_TIER_COUNT) rather than counting all rows.
 *
 * @param db          Database adapter — used to count completed jobs.
 * @param workspaceId Workspace to scope the count query.
 * @returns `'hot'` or `'cold'`.
 */
export async function classifyTier(
  db: DbAdapter,
  workspaceId: string,
): Promise<'hot' | 'cold'> {
  const { rows } = await db.query<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
     FROM (
       SELECT id
       FROM jobs
       WHERE workspace_id = ?
         AND status IN ('done', 'reported', 'error')
         AND deleted_at IS NULL
       ORDER BY timestamp DESC
       LIMIT ?
     )`,
    [workspaceId, MEMORY_HOT_TIER_COUNT],
  );

  const cnt = rows[0]?.cnt ?? 0;
  return cnt < MEMORY_HOT_TIER_COUNT ? 'hot' : 'cold';
}

// ---------------------------------------------------------------------------
// embedHot
// ---------------------------------------------------------------------------

/**
 * Embed a single text using the Voyage real-time API (voyage-3-large).
 *
 * Returns `null` in all error cases (missing API key, non-200 response,
 * network timeout, unexpected shape). The caller treats `null` as a
 * graceful fallback — Hindsight embeds on first recall.
 *
 * @param text Text to embed (should be the memory fact text).
 * @returns Embedding vector, or `null` on any failure.
 */
export async function embedHot(text: string): Promise<number[] | null> {
  if (!VOYAGE_API_KEY) {
    // No key configured — graceful no-op; Hindsight embeds on first recall
    return null;
  }

  try {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VOYAGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'voyage-3-large', input: [text] }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn(`[embedding] embedHot: Voyage API returned ${res.status} — falling back`);
      return null;
    }

    const json = await res.json() as { data: Array<{ embedding: number[] }> };
    return json.data[0]?.embedding ?? null;
  } catch (err) {
    // Network error, timeout, or JSON parse failure — non-fatal
    console.warn('[embedding] embedHot: failed, falling back to Hindsight embedding:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// VoyageBatchClient
// ---------------------------------------------------------------------------

/**
 * Thin wrapper around the Voyage Batch Embeddings API.
 *
 * Usage:
 *   const client = new VoyageBatchClient();
 *   const batchId = await client.submit(texts);
 *   const result  = await client.poll(batchId, 4 * 60 * 60 * 1_000);
 */
export class VoyageBatchClient {
  private readonly _apiKey: string;
  private readonly _baseUrl: string;

  constructor(apiKey: string = VOYAGE_API_KEY, baseUrl = 'https://api.voyageai.com/v1') {
    this._apiKey = apiKey;
    this._baseUrl = baseUrl;
  }

  /**
   * Submit a batch embedding job to Voyage.
   *
   * @param texts Array of texts to embed.
   * @returns Voyage batch job ID.
   * @throws {Error} When the API call fails or returns a non-200 status.
   */
  async submit(texts: string[]): Promise<string> {
    const res = await fetch(`${this._baseUrl}/batch/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this._apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'voyage-3-large', input: texts }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`[VoyageBatchClient] submit failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
    }

    const json = await res.json() as { id?: string };
    if (!json.id) {
      throw new Error('[VoyageBatchClient] submit response missing batch job ID');
    }

    return json.id;
  }

  /**
   * Poll a Voyage batch job until it completes or the timeout elapses.
   *
   * @param batchId   Voyage batch job ID from {@link submit}.
   * @param timeoutMs Maximum wall-clock time to wait (e.g. 4 * 60 * 60 * 1_000 for 4 hours).
   * @returns {@link BatchResult} with embeddings and failed indices.
   * @throws {Error} When polling exceeds `timeoutMs` or the API returns a terminal error.
   */
  async poll(batchId: string, timeoutMs: number): Promise<BatchResult> {
    const deadline = Date.now() + timeoutMs;
    const POLL_INTERVAL_MS = 30_000; // poll every 30 seconds

    while (Date.now() < deadline) {
      const res = await fetch(`${this._baseUrl}/batch/embeddings/${batchId}`, {
        headers: { 'Authorization': `Bearer ${this._apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        throw new Error(`[VoyageBatchClient] poll failed: HTTP ${res.status}`);
      }

      const json = await res.json() as {
        status: string;
        data?: Array<{ embedding?: number[] }>;
        failed_indices?: number[];
      };

      if (json.status === 'completed') {
        const embeddings = (json.data ?? []).map(d => d.embedding ?? []);
        const failed = json.failed_indices ?? [];
        return { embeddings, failed };
      }

      if (json.status === 'failed') {
        throw new Error(`[VoyageBatchClient] batch job ${batchId} failed on Voyage side`);
      }

      // Still processing — wait before next poll
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
    }

    throw new Error(
      `[VoyageBatchClient] polling timed out after ${timeoutMs}ms for batch ${batchId}`,
    );
  }
}
