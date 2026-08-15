// Memory Retry Worker — drains the RetryQueue on a 5-minute interval.
//
// On each tick it calls `retryQueue.drain()` and logs the number of entries
// successfully retried at DEBUG level. Any error thrown by `drain()` is
// caught and logged at WARN so the worker never crashes.
//
// Exports:
//   startMemoryRetryWorker — starts the 5-minute interval (called once at startup)
//   stopMemoryRetryWorker  — clears the interval (called during graceful shutdown)

import { RetryQueue } from '../memory/retry-queue.ts';

// ---------------------------------------------------------------------------
// Interval handle — module-level so stopMemoryRetryWorker can clear it
// ---------------------------------------------------------------------------

let _intervalHandle: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Interval duration
// ---------------------------------------------------------------------------

const RETRY_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startMemoryRetryWorker(retryQueue: RetryQueue): void {
  _intervalHandle = setInterval(async () => {
    try {
      const count = await retryQueue.drain();
      console.debug(`[memory-retry] drained ${count} entries`);
    } catch (err) {
      console.warn(
        '[memory-retry] drain() failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }, RETRY_INTERVAL_MS);
}

export function stopMemoryRetryWorker(): void {
  if (_intervalHandle !== null) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}
