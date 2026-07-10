// Feature: monitor-server-split, Task 3.4 — Property tests for scan/sessions.ts
// Validates: Requirements 13.1, 13.2, 13.3, 13.5, 13.6

import { test, expect, describe, afterEach } from 'bun:test';
import * as fc from 'fast-check';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { scanSessions, invalidateSessionsCache } from '../src/scan/sessions.ts';
import type { SessionState } from '../src/types.ts';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures/sessions');

const VALID_STATUSES = new Set<string>(['active', 'idle', 'complete', 'rate-limited']);

// ---------------------------------------------------------------------------
// Helper: build a minimal valid SessionState object
// ---------------------------------------------------------------------------

function makeSession(chainId: string, status: SessionState['status'] = 'idle'): SessionState {
  return {
    workflowHash: `wh-${chainId}`,
    sessionJsonl: `${chainId}/session.jsonl`,
    chainId,
    chainIndex: 0,
    previousSession: '',
    topic: `Topic for ${chainId}`,
    messageCount: 1,
    userMessageCount: 1,
    contextUsagePct: 0,
    lastMessageAt: '2026-01-01T00:00:00Z',
    lastSummarisedMessageCount: 0,
    lastSummarisedAt: '',
    summaryFile: '',
    status,
    firstUserMessage: 'hi',
    lastUserMessage: 'bye',
    lastAgentMessage: 'done',
    startTime: '2026-01-01T00:00:00Z',
    workspaceId: 'default',
  };
}

// ---------------------------------------------------------------------------
// Property 5 (partial): Scan module purity — no setInterval on scanSessions call
// ---------------------------------------------------------------------------

describe('scan/sessions.ts module purity', () => {
  test('calling scanSessions does not start any new interval', async () => {
    let callCount = 0;
    const original = globalThis.setInterval;
    // @ts-expect-error — patching global for spy
    globalThis.setInterval = (...args: unknown[]) => {
      callCount++;
      return original(...(args as Parameters<typeof original>));
    };
    invalidateSessionsCache();
    await scanSessions(FIXTURE_DIR);
    globalThis.setInterval = original;
    expect(callCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Invariant: result length ≥ 0; every status is a member of VALID_STATUSES
// ---------------------------------------------------------------------------

describe('scanSessions invariants', () => {
  test('result length is non-negative and every status is valid (fixture)', async () => {
    invalidateSessionsCache();
    const sessions = await scanSessions(FIXTURE_DIR);
    expect(sessions.length).toBeGreaterThanOrEqual(0);
    for (const s of sessions) {
      expect(VALID_STATUSES.has(s.status)).toBe(true);
    }
  });

  test('fixture returns exactly 3 sessions (2 primary + 1 orphan)', async () => {
    invalidateSessionsCache();
    const sessions = await scanSessions(FIXTURE_DIR);
    expect(sessions.length).toBe(3);
  });

  test('fc: every status in any scanned session is from the valid set', async () => {
    invalidateSessionsCache();
    const sessions = await scanSessions(FIXTURE_DIR);
    // Property: for all sessions in the result, status must be valid
    fc.assert(
      fc.property(
        fc.constantFrom(...sessions),
        (session) => VALID_STATUSES.has(session.status)
      ),
      { numRuns: sessions.length * 3 }
    );
  });
});

// ---------------------------------------------------------------------------
// Round-trip: two consecutive calls return equivalent results
// ---------------------------------------------------------------------------

describe('scanSessions round-trip', () => {
  test('calling scanSessions twice returns same length and chainIds', async () => {
    invalidateSessionsCache();
    const first = await scanSessions(FIXTURE_DIR);
    invalidateSessionsCache();
    const second = await scanSessions(FIXTURE_DIR);

    expect(first.length).toBe(second.length);

    const sortedFirst  = [...first].map(s => s.chainId).sort();
    const sortedSecond = [...second].map(s => s.chainId).sort();
    expect(sortedFirst).toEqual(sortedSecond);
  });
});

// ---------------------------------------------------------------------------
// Metamorphic: adding one valid SessionState file increases count by exactly 1
// ---------------------------------------------------------------------------

describe('scanSessions metamorphic', () => {
  const tempChainDir = join(FIXTURE_DIR, '_temp-metamorphic_chain-delta');
  const tempStateDir = join(tempChainDir, 'State');
  const tempFile     = join(tempStateDir, 'session-delta.json');

  afterEach(() => {
    // Clean up temp directory regardless of pass/fail
    try { rmSync(tempChainDir, { recursive: true, force: true }); } catch {}
    invalidateSessionsCache();
  });

  test('adding one session file increases count by exactly 1', async () => {
    invalidateSessionsCache();
    const before = await scanSessions(FIXTURE_DIR);
    const baseCount = before.length;

    // Write a new valid session fixture
    mkdirSync(tempStateDir, { recursive: true });
    writeFileSync(tempFile, JSON.stringify(makeSession('chain-delta', 'complete')));

    invalidateSessionsCache();
    const after = await scanSessions(FIXTURE_DIR);

    expect(after.length).toBe(baseCount + 1);
  });

  test('fc: adding N sessions increases count by exactly N', async () => {
    // Use fc to pick a small N between 1 and 3 for the metamorphic check
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        async (n) => {
          // Reset state for each fc run
          try { rmSync(tempChainDir, { recursive: true, force: true }); } catch {}
          invalidateSessionsCache();

          const before = await scanSessions(FIXTURE_DIR);
          const baseCount = before.length;

          mkdirSync(tempStateDir, { recursive: true });
          for (let i = 0; i < n; i++) {
            writeFileSync(
              join(tempStateDir, `session-fc-${i}.json`),
              JSON.stringify(makeSession(`chain-fc-${i}`, 'idle'))
            );
          }

          invalidateSessionsCache();
          const after = await scanSessions(FIXTURE_DIR);
          return after.length === baseCount + n;
        }
      ),
      { numRuns: 3 }
    );
  });
});
