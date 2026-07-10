// SSE Broadcaster — manages the shared sseClients Set and the 2-second change-
// detection interval that pushes "data: update\n\n" to all connected clients.
//
// Exports:
//   sseClients          — shared Set<SSEController> imported by routes/sse.ts and
//                         routes/system.ts; ES module semantics guarantee one reference.
//   startSSEBroadcaster — starts the 2-second interval (called once at startup)
//   stopSSEBroadcaster  — clears the interval (called during graceful shutdown)
//   emitSSEUpdate       — sends a structured SSEUpdateEvent to all connected clients

import type { SSEController, SSEUpdateEvent } from '../types.ts';
import { OUTPUT_DIR } from '../constants.ts';

// ---------------------------------------------------------------------------
// Shared client set — single object reference across all importers
// ---------------------------------------------------------------------------

export const sseClients = new Set<SSEController>();

// ---------------------------------------------------------------------------
// Change detection — tracks file mtimes in the output directory
// ---------------------------------------------------------------------------

let lastMtimes: Map<string, number> = new Map();

async function checkForChanges(): Promise<boolean> {
  try {
    const filenames = await Array.fromAsync(
      new Bun.Glob("*.{md,log}").scan(OUTPUT_DIR)
    );
    let changed = false;
    const currentFiles = new Set(filenames);

    // Check for new or modified files
    for (const f of filenames) {
      const file = Bun.file(`${OUTPUT_DIR}/${f}`);
      const mtime = file.lastModified;
      const prev = lastMtimes.get(f);
      if (prev !== mtime) {
        lastMtimes.set(f, mtime);
        changed = true;
      }
    }

    // Check for removed files
    for (const f of lastMtimes.keys()) {
      if (!currentFiles.has(f)) {
        lastMtimes.delete(f);
        changed = true;
      }
    }

    return changed;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Interval handle — module-level so stopSSEBroadcaster can clear it
// ---------------------------------------------------------------------------

let _intervalHandle: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startSSEBroadcaster(): void {
  _intervalHandle = setInterval(async () => {
    try {
      const changed = await checkForChanges();
      if (!changed || sseClients.size === 0) return;
      const payload = 'data: update\n\n';
      for (const client of sseClients) {
        try {
          if (!client.closed) client.enqueue(payload);
        } catch {
          sseClients.delete(client);
        }
      }
    } catch (err) {
      console.error('[sse-broadcaster] interval error:', err instanceof Error ? err.stack : err);
    }
  }, 2000);
}

export function stopSSEBroadcaster(): void {
  if (_intervalHandle !== null) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}

// ---------------------------------------------------------------------------
// Structured event emission — sends typed SSEUpdateEvent to all clients
// ---------------------------------------------------------------------------

/**
 * Emit a structured SSEUpdateEvent to all connected SSE clients.
 * The event is JSON-serialised and sent as a standard SSE `data:` frame.
 * Includes workspaceId in all emitted events per Requirements 11.2-11.5.
 */
export function emitSSEUpdate(event: SSEUpdateEvent): void {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      if (!client.closed) client.enqueue(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}
