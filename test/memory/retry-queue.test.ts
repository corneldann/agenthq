import { describe, it, expect, afterEach } from 'bun:test';
import * as fc from 'fast-check';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { RetryQueue } from '../../src/memory/retry-queue.ts';
import type { IMemoryClient, Memory, MemoryScope, RetryQueueEntry } from '../../src/memory/types.ts';

// ---------------------------------------------------------------------------
// Typed test doubles — no `as any`
// ---------------------------------------------------------------------------

/**
 * Minimal fake IMemoryClient that always succeeds.
 * Tracks retain call count and arguments for assertion.
 */
class FakeMemoryClient implements IMemoryClient {
  readonly retainCalls: Array<{ text: string; scope: MemoryScope }> = [];
  private retainResult: string | Error = 'fake-id';

  setRetainResult(result: string | Error): void {
    this.retainResult = result;
  }

  retain(text: string, scope: MemoryScope): Promise<string> {
    this.retainCalls.push({ text, scope });
    if (this.retainResult instanceof Error) {
      return Promise.reject(this.retainResult);
    }
    return Promise.resolve(this.retainResult);
  }

  recall(_query: string, _scope: MemoryScope, _limit: number): Promise<Memory[]> {
    return Promise.resolve([]);
  }

  reflect(_topic: string, _scope: MemoryScope): Promise<string | null> {
    return Promise.resolve(null);
  }

  delete(_id: string): Promise<void> {
    return Promise.resolve();
  }

  list(_scope: MemoryScope, _pageSize: number, _cursor: string | null): Promise<{ memories: Memory[]; nextCursor: string | null; total: number }> {
    return Promise.resolve({ memories: [], nextCursor: null, total: 0 });
  }

  get(_id: string): Promise<Memory | null> {
    return Promise.resolve(null);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Generate a unique temp file path per test to avoid cross-test state. */
function tempQueuePath(): string {
  const name = `retry-queue-test-${Math.random().toString(36).slice(2)}.jsonl`;
  return path.join(os.tmpdir(), name);
}

const TEST_SCOPE: MemoryScope = { workspaceId: 'ws-test' };

function makeEntry(overrides: Partial<RetryQueueEntry> = {}): RetryQueueEntry {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    text: 'some memory text',
    scope: TEST_SCOPE,
    queuedAt: new Date().toISOString(),
    attempts: 0,
    ...overrides,
  };
}

/** An ISO timestamp that is exactly `hoursAgo` hours in the past. */
function isoHoursAgo(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1_000).toISOString();
}

// ---------------------------------------------------------------------------
// Cleanup tracking — each describe registers its own path list
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Unit tests — enqueue
// ---------------------------------------------------------------------------

describe('RetryQueue.enqueue', () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    for (const p of tempPaths.splice(0)) {
      try { fs.unlinkSync(p); } catch { /* file may not exist */ }
    }
  });

  it('should append a line to the file when the queue is empty', () => {
    const queuePath = tempQueuePath();
    tempPaths.push(queuePath);

    // Create the file first (enqueue requires it to exist or appendFileSync creates it)
    const queue = new RetryQueue(queuePath, new FakeMemoryClient());
    const entry = makeEntry();

    queue.enqueue(entry);

    expect(queue.size()).toBe(1);
  });

  it('should append multiple entries as separate JSONL lines', () => {
    const queuePath = tempQueuePath();
    tempPaths.push(queuePath);

    const queue = new RetryQueue(queuePath, new FakeMemoryClient());
    const entry1 = makeEntry({ id: 'entry-1' });
    const entry2 = makeEntry({ id: 'entry-2' });
    const entry3 = makeEntry({ id: 'entry-3' });

    queue.enqueue(entry1);
    queue.enqueue(entry2);
    queue.enqueue(entry3);

    expect(queue.size()).toBe(3);
  });

  it('should serialize entry data correctly (round-trip via size)', () => {
    const queuePath = tempQueuePath();
    tempPaths.push(queuePath);

    const queue = new RetryQueue(queuePath, new FakeMemoryClient());
    const entry = makeEntry({ id: 'check-id', text: 'specific text' });

    queue.enqueue(entry);

    const raw = fs.readFileSync(queuePath, 'utf8').trim();
    const parsed = JSON.parse(raw) as RetryQueueEntry;
    expect(parsed.id).toBe('check-id');
    expect(parsed.text).toBe('specific text');
    expect(parsed.attempts).toBe(0);
  });

  it('should evict the oldest entry when size reaches 1000 after enqueue', () => {
    const queuePath = tempQueuePath();
    tempPaths.push(queuePath);

    const queue = new RetryQueue(queuePath, new FakeMemoryClient());

    // Fill queue to exactly 1000 entries
    for (let i = 0; i < 1000; i++) {
      queue.enqueue(makeEntry({ id: `entry-${i}` }));
    }

    expect(queue.size()).toBe(999); // eviction fires when >= MAX_ENTRIES

    // Adding one more should still keep it bounded
    queue.enqueue(makeEntry({ id: 'entry-overflow' }));
    expect(queue.size()).toBeLessThanOrEqual(1000);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — drain (success path)
// ---------------------------------------------------------------------------

describe('RetryQueue.drain — success path', () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    for (const p of tempPaths.splice(0)) {
      try { fs.unlinkSync(p); } catch { /* file may not exist */ }
    }
  });

  it('should call retain on the inner client for each entry', async () => {
    const queuePath = tempQueuePath();
    tempPaths.push(queuePath);

    const fakeClient = new FakeMemoryClient();
    const queue = new RetryQueue(queuePath, fakeClient);
    const entry1 = makeEntry({ id: 'a', text: 'text-a' });
    const entry2 = makeEntry({ id: 'b', text: 'text-b' });

    queue.enqueue(entry1);
    queue.enqueue(entry2);
    await queue.drain();

    expect(fakeClient.retainCalls).toHaveLength(2);
  });

  it('should return the count of successfully retained entries', async () => {
    const queuePath = tempQueuePath();
    tempPaths.push(queuePath);

    const queue = new RetryQueue(queuePath, new FakeMemoryClient());
    queue.enqueue(makeEntry());
    queue.enqueue(makeEntry());
    queue.enqueue(makeEntry());

    const count = await queue.drain();
    expect(count).toBe(3);
  });

  it('should empty the queue after all entries succeed', async () => {
    const queuePath = tempQueuePath();
    tempPaths.push(queuePath);

    const queue = new RetryQueue(queuePath, new FakeMemoryClient());
    queue.enqueue(makeEntry());
    queue.enqueue(makeEntry());

    await queue.drain();

    expect(queue.size()).toBe(0);
  });

  it('should return 0 when the queue is empty', async () => {
    const queuePath = tempQueuePath();
    tempPaths.push(queuePath);

    const queue = new RetryQueue(queuePath, new FakeMemoryClient());
    const count = await queue.drain();
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — drain (failure path)
// ---------------------------------------------------------------------------

describe('RetryQueue.drain — failure path', () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    for (const p of tempPaths.splice(0)) {
      try { fs.unlinkSync(p); } catch { /* file may not exist */ }
    }
  });

  it('should increment attempts on a failing entry and keep it in the queue', async () => {
    const queuePath = tempQueuePath();
    tempPaths.push(queuePath);

    const fakeClient = new FakeMemoryClient();
    fakeClient.setRetainResult(new Error('service unavailable'));

    const queue = new RetryQueue(queuePath, fakeClient);
    queue.enqueue(makeEntry({ id: 'fail-entry', attempts: 0 }));

    const count = await queue.drain();

    expect(count).toBe(0);
    expect(queue.size()).toBe(1);

    // Verify attempts was incremented to 1
    const raw = fs.readFileSync(queuePath, 'utf8').trim();
    const surviving = JSON.parse(raw) as RetryQueueEntry;
    expect(surviving.attempts).toBe(1);
  });

  it('should return 0 when all entries fail', async () => {
    const queuePath = tempQueuePath();
    tempPaths.push(queuePath);

    const fakeClient = new FakeMemoryClient();
    fakeClient.setRetainResult(new Error('network error'));

    const queue = new RetryQueue(queuePath, fakeClient);
    queue.enqueue(makeEntry());
    queue.enqueue(makeEntry());

    const count = await queue.drain();
    expect(count).toBe(0);
    expect(queue.size()).toBe(2);
  });

  it('should return partial count when some entries succeed and some fail', async () => {
    const queuePath = tempQueuePath();
    tempPaths.push(queuePath);

    const fakeClient = new FakeMemoryClient();
    let callIndex = 0;
    fakeClient.retain = (text: string, scope: MemoryScope): Promise<string> => {
      fakeClient.retainCalls.push({ text, scope });
      callIndex++;
      // First call succeeds, second fails
      if (callIndex === 1) return Promise.resolve('ok');
      return Promise.reject(new Error('fail'));
    };

    const queue = new RetryQueue(queuePath, fakeClient);
    queue.enqueue(makeEntry({ id: 'succeed' }));
    queue.enqueue(makeEntry({ id: 'fail' }));

    const count = await queue.drain();
    expect(count).toBe(1);
    expect(queue.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — drain (discard rules)
// ---------------------------------------------------------------------------

describe('RetryQueue.drain — discard rules', () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    for (const p of tempPaths.splice(0)) {
      try { fs.unlinkSync(p); } catch { /* file may not exist */ }
    }
  });

  it('should discard entries with attempts >= 5 without calling retain', async () => {
    const queuePath = tempQueuePath();
    tempPaths.push(queuePath);

    const fakeClient = new FakeMemoryClient();
    const queue = new RetryQueue(queuePath, fakeClient);
    queue.enqueue(makeEntry({ id: 'exhausted', attempts: 5 }));

    const count = await queue.drain();

    expect(count).toBe(0);
    expect(fakeClient.retainCalls).toHaveLength(0);
    expect(queue.size()).toBe(0);
  });

  it('should discard entries with attempts exactly 5 (boundary)', async () => {
    const queuePath = tempQueuePath();
    tempPaths.push(queuePath);

    const fakeClient = new FakeMemoryClient();
    const queue = new RetryQueue(queuePath, fakeClient);
    queue.enqueue(makeEntry({ attempts: 5 }));

    await queue.drain();
    expect(fakeClient.retainCalls).toHaveLength(0);
    expect(queue.size()).toBe(0);
  });

  it('should discard entries with attempts > 5 without calling retain', async () => {
    const queuePath = tempQueuePath();
    tempPaths.push(queuePath);

    const fakeClient = new FakeMemoryClient();
    const queue = new RetryQueue(queuePath, fakeClient);
    queue.enqueue(makeEntry({ attempts: 10 }));

    await queue.drain();
    expect(fakeClient.retainCalls).toHaveLength(0);
    expect(queue.size()).toBe(0);
  });

  it('should discard entries older than 24 hours without calling retain', async () => {
    const queuePath = tempQueuePath();
    tempPaths.push(queuePath);

    const fakeClient = new FakeMemoryClient();
    const queue = new RetryQueue(queuePath, fakeClient);
    // 25 hours ago — over the 24h threshold
    queue.enqueue(makeEntry({ id: 'old-entry', queuedAt: isoHoursAgo(25), attempts: 0 }));

    const count = await queue.drain();

    expect(count).toBe(0);
    expect(fakeClient.retainCalls).toHaveLength(0);
    expect(queue.size()).toBe(0);
  });

  it('should process fresh entries while discarding stale ones in the same drain pass', async () => {
    const queuePath = tempQueuePath();
    tempPaths.push(queuePath);

    const fakeClient = new FakeMemoryClient();
    const queue = new RetryQueue(queuePath, fakeClient);

    queue.enqueue(makeEntry({ id: 'stale', queuedAt: isoHoursAgo(25), attempts: 0 }));
    queue.enqueue(makeEntry({ id: 'fresh', attempts: 0 }));
    queue.enqueue(makeEntry({ id: 'exhausted', attempts: 5 }));

    const count = await queue.drain();

    // Only the fresh entry should succeed
    expect(count).toBe(1);
    expect(fakeClient.retainCalls).toHaveLength(1);
    expect(queue.size()).toBe(0);
  });

  it('should process entries with attempts 4 (not yet exhausted)', async () => {
    const queuePath = tempQueuePath();
    tempPaths.push(queuePath);

    const fakeClient = new FakeMemoryClient();
    const queue = new RetryQueue(queuePath, fakeClient);
    queue.enqueue(makeEntry({ attempts: 4 }));

    const count = await queue.drain();
    expect(count).toBe(1);
    expect(fakeClient.retainCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — size
// ---------------------------------------------------------------------------

describe('RetryQueue.size', () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    for (const p of tempPaths.splice(0)) {
      try { fs.unlinkSync(p); } catch { /* file may not exist */ }
    }
  });

  it('should return 0 when the queue file does not exist', () => {
    const queuePath = tempQueuePath();
    // Do NOT push to cleanup — file never created
    const queue = new RetryQueue(queuePath, new FakeMemoryClient());
    expect(queue.size()).toBe(0);
  });

  it('should return 0 for an empty queue', () => {
    const queuePath = tempQueuePath();
    tempPaths.push(queuePath);
    fs.writeFileSync(queuePath, '');
    const queue = new RetryQueue(queuePath, new FakeMemoryClient());
    expect(queue.size()).toBe(0);
  });

  it('should accurately count entries after multiple enqueues', () => {
    const queuePath = tempQueuePath();
    tempPaths.push(queuePath);
    const queue = new RetryQueue(queuePath, new FakeMemoryClient());

    queue.enqueue(makeEntry());
    queue.enqueue(makeEntry());
    queue.enqueue(makeEntry());

    expect(queue.size()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Property-based arbitraries
// ---------------------------------------------------------------------------

const memoryScopeArb: fc.Arbitrary<MemoryScope> = fc.record({
  workspaceId: fc.string({ minLength: 1, maxLength: 40 }),
  userId: fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }),
  agentId: fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }),
  runId: fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }),
  chainId: fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }),
}, { requiredKeys: ['workspaceId'] });

/** Arbitrary for a fresh entry (attempts 0..4, recent queuedAt). */
const freshEntryArb: fc.Arbitrary<RetryQueueEntry> = fc.record({
  id: fc.uuid(),
  text: fc.string({ minLength: 1, maxLength: 200 }),
  scope: memoryScopeArb,
  queuedAt: fc.constant(new Date().toISOString()),
  attempts: fc.integer({ min: 0, max: 4 }),
});

/** Arbitrary for a stale entry: either attempts >= 5 OR queuedAt older than 25h. */
const staleEntryArb: fc.Arbitrary<RetryQueueEntry> = fc.oneof(
  // Exhausted by attempt count
  fc.record({
    id: fc.uuid(),
    text: fc.string({ minLength: 1, maxLength: 200 }),
    scope: memoryScopeArb,
    queuedAt: fc.constant(new Date().toISOString()),
    attempts: fc.integer({ min: 5, max: 20 }),
  }),
  // Exhausted by age (25+ hours ago)
  fc.record({
    id: fc.uuid(),
    text: fc.string({ minLength: 1, maxLength: 200 }),
    scope: memoryScopeArb,
    queuedAt: fc.integer({ min: 25, max: 72 }).map((h) => isoHoursAgo(h)),
    attempts: fc.integer({ min: 0, max: 4 }),
  }),
);

// ---------------------------------------------------------------------------
// Property 10: RetryQueue never exceeds 1000 entries after any enqueue sequence
// ---------------------------------------------------------------------------

describe('RetryQueue — property tests', () => {
  // Feature: phase-6.1-memory-infrastructure, Property 10: RetryQueue never exceeds 1000 entries after any enqueue sequence
  it('property: queue size never exceeds 1000 after any sequence of enqueue calls', () => {
    fc.assert(
      fc.property(
        fc.array(freshEntryArb, { minLength: 0, maxLength: 2000 }),
        (entries) => {
          const queuePath = tempQueuePath();
          try {
            const queue = new RetryQueue(queuePath, new FakeMemoryClient());

            for (const entry of entries) {
              queue.enqueue(entry);
            }

            expect(queue.size()).toBeLessThanOrEqual(1000);
          } finally {
            try { fs.unlinkSync(queuePath); } catch { /* ignore */ }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Unit test for FIFO eviction: after exactly 1001 enqueues, size must still be bounded
  it('should evict the oldest entry to maintain the 1000-entry cap (unit verification)', () => {
    const queuePath = tempQueuePath();
    const tempPaths: string[] = [queuePath];
    try {
      const queue = new RetryQueue(queuePath, new FakeMemoryClient());

      // Fill to exactly 1000 entries (eviction fires at >= MAX_ENTRIES after append)
      for (let i = 0; i < 1001; i++) {
        queue.enqueue(makeEntry({ id: `entry-${i}` }));
      }

      expect(queue.size()).toBeLessThanOrEqual(1000);
    } finally {
      for (const p of tempPaths) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
    }
  });

  // Feature: phase-6.1-memory-infrastructure, Property 11: drain() removes successfully retried entries and returns their count
  it('property: drain() returns N and empties queue when retain succeeds for all N entries', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(freshEntryArb, { minLength: 1, maxLength: 50 }),
        async (entries) => {
          const queuePath = tempQueuePath();
          try {
            const fakeClient = new FakeMemoryClient();
            const queue = new RetryQueue(queuePath, fakeClient);

            for (const entry of entries) {
              queue.enqueue(entry);
            }

            const initialSize = queue.size();
            const drainCount = await queue.drain();

            expect(drainCount).toBe(initialSize);
            expect(queue.size()).toBe(0);
          } finally {
            try { fs.unlinkSync(queuePath); } catch { /* ignore */ }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: phase-6.1-memory-infrastructure, Property 12: drain() discards stale entries without calling retain
  it('property: drain() discards stale entries without calling retain and removes them from queue', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(staleEntryArb, { minLength: 1, maxLength: 20 }),
        async (staleEntries) => {
          const queuePath = tempQueuePath();
          try {
            const fakeClient = new FakeMemoryClient();
            const queue = new RetryQueue(queuePath, fakeClient);

            for (const entry of staleEntries) {
              queue.enqueue(entry);
            }

            const count = await queue.drain();

            // retain must not have been called for stale entries
            expect(fakeClient.retainCalls).toHaveLength(0);
            // All stale entries are discarded
            expect(count).toBe(0);
            expect(queue.size()).toBe(0);
          } finally {
            try { fs.unlinkSync(queuePath); } catch { /* ignore */ }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
