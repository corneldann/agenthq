// ---------------------------------------------------------------------------
// RetryQueue — JSONL-backed bounded queue for failed `retain` calls.
//
// The queue is stored as a JSONL file (one JSON-stringified RetryQueueEntry
// per line). It is bounded at MAX_ENTRIES (1 000); when a new entry would
// exceed the cap the oldest entry is silently discarded (FIFO eviction).
//
// Concurrency note: `enqueue` is intentionally synchronous so callers that
// must queue in a `catch` block can do so without async complexity. `drain`
// is async and should not be run concurrently — the retry worker calls it
// on a 5-minute interval which serialises naturally.
// ---------------------------------------------------------------------------

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import type { IMemoryClient, RetryQueueEntry } from './types.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 1_000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1_000;
const MAX_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// RetryQueue
// ---------------------------------------------------------------------------

export class RetryQueue {
  readonly #path: string;
  readonly #inner: IMemoryClient;

  constructor(path: string, inner: IMemoryClient) {
    this.#path = path;
    this.#inner = inner;
  }

  // -------------------------------------------------------------------------
  // enqueue — synchronous append with FIFO eviction at cap
  // -------------------------------------------------------------------------

  /**
   * Append a RetryQueueEntry to the JSONL file.
   * If the queue has reached MAX_ENTRIES after appending, the oldest entry
   * (first line) is silently discarded to make room (FIFO eviction).
   * I/O failures are logged at WARN and swallowed — callers must never crash.
   */
  enqueue(entry: RetryQueueEntry): void {
    try {
      appendFileSync(this.#path, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      console.warn(
        '[retry-queue] enqueue: failed to append entry — write skipped.',
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    // FIFO eviction: if at or over the cap, drop the oldest line.
    try {
      const raw = readFileSync(this.#path, 'utf8');
      const lines = raw.split('\n').filter(l => l.trim().length > 0);
      if (lines.length >= MAX_ENTRIES) {
        // Drop the first (oldest) line, keep all others.
        const trimmed = lines.slice(1).join('\n') + '\n';
        writeFileSync(this.#path, trimmed);
      }
    } catch (err) {
      console.warn(
        '[retry-queue] enqueue: failed during FIFO eviction check.',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // -------------------------------------------------------------------------
  // drain — async, processes all entries sequentially
  // -------------------------------------------------------------------------

  /**
   * Read all queue entries and attempt to retry each via the inner client.
   *
   * Entries are processed sequentially. For each entry:
   * - Skip (discard) if `attempts >= MAX_ATTEMPTS` or entry is older than 24 h.
   * - Otherwise call `inner.retain(entry.text, entry.scope)`.
   *   - On success: remove from the surviving list.
   *   - On failure: increment `attempts` and keep in the surviving list.
   *
   * After processing, the file is rewritten with only the surviving entries.
   *
   * @returns The count of entries successfully retried.
   */
  async drain(): Promise<number> {
    let raw: string;
    try {
      const file = Bun.file(this.#path);
      raw = await file.text();
    } catch (err) {
      console.warn(
        '[retry-queue] drain: failed to read queue file — drain pass skipped.',
        err instanceof Error ? err.message : String(err),
      );
      return 0;
    }

    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) {
      return 0;
    }

    const entries = parseEntries(lines);
    const now = Date.now();
    let successCount = 0;

    // Entries that must be written back after the drain pass.
    const surviving: RetryQueueEntry[] = [];

    for (const entry of entries) {
      // Discard stale or exhausted entries without calling retain.
      if (shouldDiscard(entry, now)) {
        console.warn(
          `[retry-queue] drain: discarding stale entry id=${entry.id} ` +
          `(attempts=${entry.attempts}, queuedAt=${entry.queuedAt})`,
        );
        continue;
      }

      try {
        await this.#inner.retain(entry.text, entry.scope);
        successCount++;
        // Entry successfully retried — do not include in surviving list.
      } catch (err) {
        // retain failed; increment attempts and keep in the queue.
        console.warn(
          `[retry-queue] drain: retain failed for entry id=${entry.id} ` +
          `(attempts=${entry.attempts + 1}). Will retry next drain pass.`,
          err instanceof Error ? err.message : String(err),
        );
        surviving.push({ ...entry, attempts: entry.attempts + 1 });
      }
    }

    // Rewrite the file with surviving entries.
    try {
      const content = surviving.length > 0
        ? surviving.map(e => JSON.stringify(e)).join('\n') + '\n'
        : '';
      await Bun.write(this.#path, content);
    } catch (err) {
      console.warn(
        '[retry-queue] drain: failed to rewrite queue file after drain.',
        err instanceof Error ? err.message : String(err),
      );
    }

    return successCount;
  }

  // -------------------------------------------------------------------------
  // size — synchronous count of non-empty lines
  // -------------------------------------------------------------------------

  /**
   * Return the current number of entries in the queue.
   * Returns 0 if the file does not exist or cannot be read.
   */
  size(): number {
    try {
      const raw = readFileSync(this.#path, 'utf8');
      return raw.split('\n').filter(l => l.trim().length > 0).length;
    } catch {
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Parse JSONL lines into RetryQueueEntry objects, silently dropping any
 * lines that cannot be parsed (malformed JSON, unexpected shape).
 */
function parseEntries(lines: string[]): RetryQueueEntry[] {
  const entries: RetryQueueEntry[] = [];
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRetryQueueEntry(parsed)) {
        entries.push(parsed);
      } else {
        console.warn('[retry-queue] parseEntries: skipping malformed entry line.');
      }
    } catch {
      console.warn('[retry-queue] parseEntries: skipping non-parseable line.');
    }
  }
  return entries;
}

/**
 * Returns true when the entry should be discarded during a drain pass:
 * - attempts >= MAX_ATTEMPTS (5), OR
 * - queuedAt is older than 24 hours.
 */
function shouldDiscard(entry: RetryQueueEntry, nowMs: number): boolean {
  if (entry.attempts >= MAX_ATTEMPTS) {
    return true;
  }
  const queuedMs = new Date(entry.queuedAt).getTime();
  return nowMs - queuedMs > TWENTY_FOUR_HOURS_MS;
}

/**
 * Type guard for RetryQueueEntry. Validates that the required fields are
 * present and have the expected primitive types.
 */
function isRetryQueueEntry(value: unknown): value is RetryQueueEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['text'] === 'string' &&
    typeof v['queuedAt'] === 'string' &&
    typeof v['attempts'] === 'number' &&
    isMemoryScope(v['scope'])
  );
}

function isMemoryScope(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return typeof v['workspaceId'] === 'string';
}
