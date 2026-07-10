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
import type { DbAdapter } from '../db/adapter.js';
import { DbSyncTool } from '../db/sync.js';

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
 * All errors are caught and logged via `console.error` — this function never
 * throws.
 *
 * @param db        Database adapter (already open, migrations already applied)
 * @param outputDir Absolute path to the agent output directory; also used as workspaceId
 */
export function startFileWatcher(db: DbAdapter, outputDir: string): void {
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
        .then(() => {
          const duration = Date.now() - start;
          console.log(
            `[file-watcher] synced path="${resolvedPath}" duration=${duration}ms`,
          );
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
