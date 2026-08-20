// ---------------------------------------------------------------------------
// Memory batch embedding worker — cold-tier embedding via Voyage Batch API.
//
// Every 6 hours (with an initial 60-second delay), queries up to 1 000
// `pending` rows from `memory_extraction`, submits them to the Voyage Batch
// API, and updates their `embedding_status` to `'embedded'` or `'failed'`.
//
// Exports:
//   startBatchEmbedWorker(db, client) — starts the worker loop
//   _markExhaustedAsFailed(db)        — marks rows with embed_attempts >= 3 as failed
// ---------------------------------------------------------------------------

import type { DbAdapter } from '../db/adapter.ts';
import type { IMemoryClient } from '../memory/types.ts';
import type { DbMemoryExtraction } from '../db/adapter.ts';
import { VoyageBatchClient } from '../memory/embedding.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTERVAL_MS = 6 * 60 * 60 * 1_000;   // 6 hours
const INITIAL_DELAY_MS = 60_000;             // 1-minute startup delay
const POLL_TIMEOUT_MS = 4 * 60 * 60 * 1_000; // 4-hour polling timeout
const MAX_BATCH_SIZE = 1_000;
const MAX_EMBED_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// _markExhaustedAsFailed — exported for testability
// ---------------------------------------------------------------------------

/**
 * Mark all `pending` rows that have reached `embed_attempts >= 3` as
 * `embedding_status = 'failed'`.  Called at the end of every successful
 * batch run and after a polling timeout.
 *
 * @param db Database adapter.
 */
export async function _markExhaustedAsFailed(db: DbAdapter): Promise<void> {
  await db.execute(
    `UPDATE memory_extraction
     SET embedding_status = 'failed',
         last_modified    = ?
     WHERE embed_attempts >= ?
       AND embedding_status = 'pending'
       AND deleted_at IS NULL`,
    [Date.now(), MAX_EMBED_ATTEMPTS],
  );
}

// ---------------------------------------------------------------------------
// runBatch — one full batch-embed cycle
// ---------------------------------------------------------------------------

export async function runBatch(db: DbAdapter, voyageClient: VoyageBatchClient): Promise<void> {
  // 1. Query up to 1 000 pending rows with embed_attempts < 3
  const { rows } = await db.query<DbMemoryExtraction>(
    `SELECT * FROM memory_extraction
     WHERE embedding_status = 'pending'
       AND embed_attempts < ?
       AND deleted_at IS NULL
     ORDER BY extracted_at ASC
     LIMIT ?`,
    [MAX_EMBED_ATTEMPTS, MAX_BATCH_SIZE],
  );

  if (rows.length === 0) {
    console.debug('[batch-embed] no pending rows');
    return;
  }

  // 2. Submit to Voyage Batch API.
  //    On throw: log ERROR and exit WITHOUT modifying embed_attempts.
  let batchId: string;
  try {
    batchId = await voyageClient.submit(rows.map(r => r.raw_text));
  } catch (err) {
    console.error('[batch-embed] Voyage batch submission failed:', err);
    return; // do NOT increment embed_attempts
  }

  // 3. Increment embed_attempts for all submitted rows inside a transaction.
  //    This runs after a successful submit() call, before polling.
  const submittedIds = rows.map(r => r.id);
  await db.transaction(async (tx) => {
    for (const id of submittedIds) {
      await tx.execute(
        `UPDATE memory_extraction
         SET embed_attempts = embed_attempts + 1,
             last_modified  = ?
         WHERE id = ?`,
        [Date.now(), id],
      );
    }
  });

  // 4. Poll for completion (up to 4 hours).
  //    On timeout/error: mark exhausted rows as failed, leave the rest pending.
  let result: { embeddings: number[][]; failed: number[] };
  try {
    result = await voyageClient.poll(batchId, POLL_TIMEOUT_MS);
  } catch (err) {
    console.error('[batch-embed] Voyage batch polling timed out or failed:', err);
    await _markExhaustedAsFailed(db);
    return;
  }

  // 5. Update embedding_status per Voyage result.
  //    Only update rows with embed_attempts < MAX_EMBED_ATTEMPTS to avoid
  //    re-opening rows that were already marked exhausted.
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row === undefined) continue;

      const status: 'embedded' | 'failed' = result.failed.includes(i) ? 'failed' : 'embedded';
      await tx.execute(
        `UPDATE memory_extraction
         SET embedding_status = ?,
             last_modified    = ?
         WHERE id = ?
           AND embed_attempts < ?`,
        [status, Date.now(), row.id, MAX_EMBED_ATTEMPTS],
      );
    }
  });

  // 6. Mark any rows that have now reached embed_attempts >= 3 as failed.
  await _markExhaustedAsFailed(db);

  const failedCount = result.failed.length;
  console.log(
    `[batch-embed] processed ${rows.length} rows, ${rows.length - failedCount} embedded, ${failedCount} failed`,
  );
}

// ---------------------------------------------------------------------------
// startBatchEmbedWorker
// ---------------------------------------------------------------------------

/**
 * Start the batch embedding worker.
 *
 * Fires an initial run 60 seconds after startup, then every 6 hours.
 * Each run queries up to 1 000 `pending` rows, submits them to the Voyage
 * Batch API, and updates their `embedding_status`.
 *
 * The `client` parameter (IMemoryClient) is included in the signature for
 * forward-compatibility with pre-computed vector retention; it is not used
 * by the current batch worker logic which delegates to VoyageBatchClient.
 *
 * @param db     Database adapter used for all batch queries and updates.
 * @param client IMemoryClient — reserved for future pre-computed vector retain calls.
 */
export function startBatchEmbedWorker(db: DbAdapter, client: IMemoryClient): void {
  // Suppress unused-variable warning; client is kept for future vector retain.
  void client;

  const voyageClient = new VoyageBatchClient();

  const runSafe = (): void => {
    runBatch(db, voyageClient).catch(err => {
      console.error('[batch-embed] unexpected error:', err instanceof Error ? err.stack : err);
    });
  };

  // Fire once at startup after a short delay, then on the 6-hour interval.
  setTimeout(() => {
    runSafe();
    setInterval(runSafe, INTERVAL_MS);
  }, INITIAL_DELAY_MS);
}
