/**
 * fileWatcher — watches `outputDir` for filesystem changes and syncs them
 * to the database via `DbSyncTool`.
 *
 * Design:
 *  - On startup, runs a full sync so the DB reflects the current filesystem state.
 *  - Watches the directory recursively using `node:fs` `watch()`.
 *  - Debounces per-path at 500 ms so rapid bursts only trigger one sync call.
 *  - Errors from sync operations are caught and logged — they never propagate.
 *
 * Requirements: 2.1, 2.4, 2.5, 2.6, 10.2
 */

import { watch } from 'node:fs';
import { join } from 'node:path';
import type { DbAdapter, DbJob } from '../db/adapter.js';
import type { IMemoryClient } from '../memory/types.js';
import type { Job } from '../types.js';
import { DbSyncTool } from '../db/sync.js';
import { extractAndStore } from '../memory/extraction.js';
import { extractMarkersFromOutput } from '../routes/jobs.js';
import { MEMORY_EXTRACTION_ENABLED } from '../constants.js';

// ---------------------------------------------------------------------------
// Exported debounce helper — separated for unit testability (Task 8.1)
// ---------------------------------------------------------------------------

/**
 * Creates a debounced dispatch function that coalesces rapid calls for the
 * same `path` into a single `onFire(path)` invocation after `delayMs` ms.
 *
 * The `debouncers` map is managed externally so callers can inspect it in
 * tests.  After the timer fires, the path entry is removed from the map.
 *
 * @param debouncers  Shared map of path → pending timer handle
 * @param onFire      Callback invoked once the debounce window expires
 * @param delayMs     Debounce window in milliseconds (default 500)
 */
export function createDebouncer(
  debouncers: Map<string, ReturnType<typeof setTimeout>>,
  onFire: (path: string) => void,
  delayMs: number,
): (path: string) => void {
  return (path: string) => {
    const existing = debouncers.get(path);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      debouncers.delete(path);
      onFire(path);
    }, delayMs);
    debouncers.set(path, timer);
  };
}

// ---------------------------------------------------------------------------
// jobFromDbRow — DB row → domain type mapper
// ---------------------------------------------------------------------------

/**
 * Map a `DbJob` row (snake_case) to the `Job` domain type (camelCase).
 *
 * Boolean columns (`has_log`, `log_error`) are stored as integers (0/1) in
 * SQLite; they are coerced to `boolean` here.
 *
 * @param row A raw row from the `jobs` table.
 * @returns The equivalent `Job` domain object.
 */
export function jobFromDbRow(row: DbJob): Job {
  return {
    id: row.id,
    name: row.name,
    jobChain: row.job_chain,
    sessionChainId: row.session_chain_id,
    timestamp: row.timestamp,
    type: row.type,
    agent: row.agent,
    status: row.status,
    lines: row.lines,
    lastLine: row.last_line,
    hasLog: row.has_log !== 0,
    logError: row.log_error !== 0,
    mdFile: row.md_file,
    logFile: row.log_file,
    agentDone: row.agent_done,
    sizeBytes: row.size_bytes,
    workspaceId: row.workspace_id,
  };
}

// ---------------------------------------------------------------------------
// startFileWatcher — public entry point
// ---------------------------------------------------------------------------

/**
 * Start watching `outputDir` for filesystem changes and sync them to `db`.
 *
 * Startup behaviour:
 *  1. Creates a `DbSyncTool` bound to `db`.
 *  2. Fires `runFullSync(outputDir)` immediately (outputDir acts as workspaceId).
 *  3. Opens a recursive `fs.watch` on `outputDir`.
 *  4. Each change event is debounced per-path at 500 ms; on fire, calls
 *     `syncFile(resolvedPath, outputDir)`.
 *
 * After each successful `syncFile`, if `MEMORY_EXTRACTION_ENABLED` is true and
 * `memoryClient` is non-null, queries jobs matching the synced path and fires
 * `extractAndStore` (fire-and-forget) for any job with `status='done'`.
 *
 * All errors are caught and logged via `console.error` — this function never
 * throws.
 *
 * @param db           Database adapter (already open, migrations already applied)
 * @param outputDir    Absolute path to the agent output directory; also used as workspaceId
 * @param memoryClient Optional memory client for extraction on job completion.
 *                     Pass `null` (default) to disable extraction triggering.
 */
export function startFileWatcher(
  db: DbAdapter,
  outputDir: string,
  memoryClient: IMemoryClient | null = null,
): void {
  const syncTool = new DbSyncTool(db);

  // ── Startup full sync ───────────────────────────────────────────────────
  syncTool.runFullSync(outputDir).catch((err: unknown) => {
    console.error(
      '[file-watcher] startup full sync failed:',
      err instanceof Error ? err.stack : err,
    );
  });

  // ── Debounce map ────────────────────────────────────────────────────────
  const debouncers = new Map<string, ReturnType<typeof setTimeout>>();

  const dispatch = createDebouncer(
    debouncers,
    (resolvedPath: string) => {
      const start = Date.now();
      syncTool.syncFile(resolvedPath, outputDir)
        .then(async () => {
          const duration = Date.now() - start;
          console.log(
            `[file-watcher] synced path="${resolvedPath}" duration=${duration}ms`,
          );

          // After a successful sync, check if any job that owns this file
          // has transitioned to 'done' and trigger memory extraction.
          if (MEMORY_EXTRACTION_ENABLED && memoryClient !== null) {
            const { rows } = await db.query<DbJob>(
              `SELECT * FROM jobs WHERE (md_file = ? OR log_file = ?) AND deleted_at IS NULL`,
              [resolvedPath, resolvedPath],
            );
            for (const row of rows) {
              if (row.status === 'done') {
                const job = jobFromDbRow(row);
                
                // Fire and forget — extraction errors are logged inside extractAndStore
                extractAndStore(job, db, memoryClient).catch((err: unknown) => {
                  console.error(
                    `[file-watcher] extractAndStore error for job=${row.id}:`,
                    err instanceof Error ? err.stack : err,
                  );
                });
                
                // Fire and forget — extract MEMORY: markers from job output
                // Only extract markers if the job has an md_file (output file)
                if (row.md_file) {
                  Bun.file(row.md_file).text()
                    .then((output: string) => {
                      return extractMarkersFromOutput(output, job, memoryClient, db);
                    })
                    .catch((err: unknown) => {
                      console.error(
                        `[file-watcher] extractMarkersFromOutput error for job=${row.id}:`,
                        err instanceof Error ? err.stack : err,
                      );
                    });
                }
              }
            }
          }
        })
        .catch((err: unknown) => {
          console.error(
            `[file-watcher] syncFile failed path="${resolvedPath}":`,
            err instanceof Error ? err.stack : err,
          );
        });
    },
    500,
  );

  // ── Recursive watch ─────────────────────────────────────────────────────
  try {
    watch(outputDir, { recursive: true }, (eventType: string, filename: string | null) => {
      if (!filename) return;

      const resolvedPath = join(outputDir, filename);
      console.log(
        `[file-watcher] event type="${eventType}" path="${resolvedPath}"`,
      );

      dispatch(resolvedPath);
    });
  } catch (err) {
    console.error(
      '[file-watcher] failed to start watcher:',
      err instanceof Error ? err.stack : err,
    );
  }
}
