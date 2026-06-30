// Feature: monitor-dashboard-redesign, Property 2: setState shallow-merge correctness
// Feature: monitor-dashboard-redesign, Property 3: hiddenChains localStorage round-trip
//
// Validates: Requirements 3.2, 3.3, 3.5, 3.6

import { test, expect, beforeEach, describe } from 'bun:test';
import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// localStorage mock — Bun's test environment has no DOM globals
// ---------------------------------------------------------------------------

const localStorageStore: Record<string, string> = {};

const localStorageMock = {
  getItem: (key: string): string | null => localStorageStore[key] ?? null,
  setItem: (key: string, value: string): void => { localStorageStore[key] = value; },
  removeItem: (key: string): void => { delete localStorageStore[key]; },
  clear: (): void => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
};

// Inject mock before the module is loaded
(globalThis as Record<string, unknown>).localStorage = localStorageMock;

// ---------------------------------------------------------------------------
// Helpers to reset module-level state between tests
// ---------------------------------------------------------------------------

/**
 * Re-imports state.ts with a clean internal _state so each test is isolated.
 * Bun caches ES modules; we bypass this by appending a unique query string.
 */
async function freshModule() {
  localStorageMock.clear();
  const ts = Date.now() + Math.random();
  const mod = await import(
    `../src/dashboard/state.ts?bust=${ts}`
  ) as typeof import('../src/dashboard/state.ts');
  return mod;
}

// ---------------------------------------------------------------------------
// fast-check arbitraries
// ---------------------------------------------------------------------------

const jobStatusArb = fc.constantFrom('running', 'done', 'reported', 'error' as const);

const jobArb = fc.record({
  id: fc.uuid(),
  name: fc.string(),
  jobChain: fc.string(),
  sessionChainId: fc.string(),
  timestamp: fc.string(),
  type: fc.string(),
  agent: fc.string(),
  status: jobStatusArb,
  lines: fc.nat(),
  lastLine: fc.string(),
  hasLog: fc.boolean(),
  logError: fc.boolean(),
  mdFile: fc.string(),
  logFile: fc.string(),
  agentDone: fc.string(),
  sizeBytes: fc.nat(),
});

const pollLogEntryArb = fc.record({
  ts: fc.integer({ min: 0 }),
  type: fc.constantFrom('CRAWL', 'CLONE', 'PROMPT', 'poll' as const),
  count: fc.nat(),
  detail: fc.string(),
  workflowHash: fc.string(),
});

const systemStatusArb = fc.record({
  sseClients: fc.nat(),
  processedCount: fc.nat(),
  lastPollTime: fc.integer({ min: 0 }),
  lastPollAgo: fc.option(fc.nat(), { nil: null }),
  uptime: fc.nat(),
  workflowDirOk: fc.boolean(),
});

const gitStatusArb = fc.record({
  branch: fc.string(),
  clean: fc.boolean(),
  modified: fc.array(fc.string()),
  staged: fc.array(fc.string()),
  untracked: fc.array(fc.string()),
  ahead: fc.nat(),
  behind: fc.nat(),
});

const toastArb = fc.record({
  id: fc.uuid(),
  type: fc.constantFrom('success', 'error' as const),
  message: fc.string(),
  persistent: fc.boolean(),
});

const summariseStatusArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 20 }),
  fc.constantFrom('queued', 'done', 'error' as const),
);

const hiddenChainsArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 20 }),
  fc.boolean(),
);

const pageArb = fc.constantFrom('dashboard', 'work', 'activity' as const);

const commitStateArb = fc.constantFrom(null, 'running', 'done', 'error' as const);

/** Full AppState arbitrary (all fields populated) */
const appStateArb = fc.record({
  chains: fc.array(fc.record({
    chainId: fc.uuid(),
    displayName: fc.string(),
    nextIndex: fc.nat(),
    sessions: fc.array(fc.record({
      index: fc.nat(),
      workflowHash: fc.string(),
      date: fc.string(),
      messageCount: fc.nat(),
      status: fc.string(),
    })),
    totalMessages: fc.nat(),
    createdAt: fc.string(),
    lastActiveAt: fc.string(),
    unsummarisedDelta: fc.nat(),
    overallStatus: fc.string(),
    workflowCount: fc.nat(),
  })),
  jobChains: fc.array(fc.record({
    jobChain: fc.string(),
    sessionChainId: fc.oneof(fc.constant(''), fc.uuid()),
    type: fc.string(),
    latestStatus: fc.string(),
    latestTimestamp: fc.string(),
    runCount: fc.nat(),
    runs: fc.array(jobArb),
  })),
  jobs: fc.array(jobArb),
  pollLog: fc.array(pollLogEntryArb),
  systemStatus: fc.option(systemStatusArb, { nil: null }),
  gitStatus: fc.option(gitStatusArb, { nil: null }),
  summariseStatus: summariseStatusArb,
  hiddenChains: hiddenChainsArb,
  currentPage: pageArb,
  drawerChainId: fc.option(fc.uuid(), { nil: null }),
  commitState: commitStateArb,
  toasts: fc.array(toastArb),
});

// Partial<AppState>: pick a random subset of top-level keys
const partialAppStateArb = appStateArb.chain((full) => {
  const keys = Object.keys(full) as (keyof typeof full)[];
  return fc.subarray(keys, { minLength: 0 }).map((selectedKeys) => {
    const patch: Partial<typeof full> = {};
    for (const k of selectedKeys) {
      (patch as Record<string, unknown>)[k] = full[k];
    }
    return { full, patch };
  });
});

// ---------------------------------------------------------------------------
// Property 2: setState shallow-merge correctness
// ---------------------------------------------------------------------------

describe('Property 2 — setState shallow-merge correctness', () => {

  test('patch keys replace and non-patch keys retain', async () => {
    await fc.assert(
      fc.asyncProperty(partialAppStateArb, async ({ full, patch }) => {
        const { setState, getState, subscribe } = await freshModule();

        // Seed with a known "before" state
        setState(full);
        const before = getState();

        // Apply the patch under test
        setState(patch);
        const after = getState();

        const patchKeys = Object.keys(patch) as (keyof typeof full)[];
        const allKeys = Object.keys(full) as (keyof typeof full)[];

        // All patch keys must equal the patched value
        for (const key of patchKeys) {
          expect(after[key] as unknown).toStrictEqual(patch[key] as unknown);
        }

        // All non-patch keys must retain their before values
        const nonPatchKeys = allKeys.filter(k => !patchKeys.includes(k));
        for (const key of nonPatchKeys) {
          expect(after[key] as unknown).toStrictEqual(before[key] as unknown);
        }
      }),
      { numRuns: 100 }
    );
  });

  test('subscribers called exactly once per setState invocation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(partialAppStateArb, { minLength: 1, maxLength: 10 }),
        async (patches) => {
          const { setState, subscribe } = await freshModule();

          let callCount = 0;
          subscribe(() => { callCount++; });

          for (const { patch } of patches) {
            const before = callCount;
            setState(patch);
            // Each individual setState must fire subscriber exactly once more
            expect(callCount).toBe(before + 1);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('two consecutive non-overlapping patches both take full effect (Req 3.6)', async () => {
    await fc.assert(
      fc.asyncProperty(appStateArb, async (full) => {
        const { setState, getState } = await freshModule();

        // Split keys into two disjoint halves
        const keys = Object.keys(full) as (keyof typeof full)[];
        const midpoint = Math.floor(keys.length / 2);
        const keysA = keys.slice(0, midpoint);
        const keysB = keys.slice(midpoint);

        const patchA: Partial<typeof full> = {};
        const patchB: Partial<typeof full> = {};
        for (const k of keysA) (patchA as Record<string, unknown>)[k] = full[k];
        for (const k of keysB) (patchB as Record<string, unknown>)[k] = full[k];

        setState(patchA);
        setState(patchB);
        const state = getState();

        // All keys from both patches must be present after both calls
        for (const k of keysA) expect(state[k] as unknown).toStrictEqual(patchA[k] as unknown);
        for (const k of keysB) expect(state[k] as unknown).toStrictEqual(patchB[k] as unknown);
      }),
      { numRuns: 100 }
    );
  });

  test('unsubscribe removes the subscriber — no further calls', async () => {
    await fc.assert(
      fc.asyncProperty(partialAppStateArb, partialAppStateArb, async ({ patch: p1 }, { patch: p2 }) => {
        const { setState, subscribe } = await freshModule();

        let count = 0;
        const unsub = subscribe(() => { count++; });

        setState(p1);
        expect(count).toBe(1); // fired once

        unsub();

        setState(p2);
        expect(count).toBe(1); // must NOT have fired again
      }),
      { numRuns: 100 }
    );
  });

  test('multiple subscribers are all called exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 8 }),
        partialAppStateArb,
        async (n, { patch }) => {
          const { setState, subscribe } = await freshModule();

          const counts = Array.from({ length: n }, () => ({ v: 0 }));
          for (const counter of counts) subscribe(() => { counter.v++; });

          setState(patch);

          for (const counter of counts) {
            expect(counter.v).toBe(1);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

});

// ---------------------------------------------------------------------------
// Property 3: hiddenChains localStorage round-trip
// ---------------------------------------------------------------------------
// Feature: monitor-dashboard-redesign, Property 3: hiddenChains localStorage round-trip
// Validates: Requirement 3.5

describe('Property 3 — hiddenChains localStorage round-trip', () => {

  test('setState({ hiddenChains }) serialises to localStorage and fresh init restores identical map', async () => {
    await fc.assert(
      fc.asyncProperty(hiddenChainsArb, async (hiddenChains) => {
        // Module 1: write hiddenChains via setState
        const mod1 = await freshModule();
        mod1.setState({ hiddenChains });

        // Verify it was written to localStorage under the correct key
        const stored = localStorageMock.getItem('sw-monitor-hidden-chains');
        expect(stored).not.toBeNull();
        expect(JSON.parse(stored!)).toStrictEqual(hiddenChains);

        // Module 2: fresh init reads from the same localStorage (mock is shared)
        const ts2 = Date.now() + Math.random() + 1;
        const mod2 = await import(
          `../src/dashboard/state.ts?bust=${ts2}`
        ) as typeof import('../src/dashboard/state.ts');

        // hiddenChains in the newly initialised module must match the original map
        expect(mod2.getState().hiddenChains).toStrictEqual(hiddenChains);
      }),
      { numRuns: 100 }
    );
  });

  test('empty hiddenChains map round-trips correctly', async () => {
    const mod1 = await freshModule();
    mod1.setState({ hiddenChains: {} });

    const stored = localStorageMock.getItem('sw-monitor-hidden-chains');
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toStrictEqual({});

    const ts2 = Date.now() + Math.random() + 1;
    const mod2 = await import(
      `../src/dashboard/state.ts?bust=${ts2}`
    ) as typeof import('../src/dashboard/state.ts');

    expect(mod2.getState().hiddenChains).toStrictEqual({});
  });

  test('absent localStorage key defaults hiddenChains to {}', async () => {
    // freshModule() calls localStorageMock.clear() — no key present
    const mod = await freshModule();
    expect(mod.getState().hiddenChains).toStrictEqual({});
  });

  test('malformed JSON in localStorage defaults hiddenChains to {}', async () => {
    // Seed malformed JSON before module init
    localStorageMock.clear();
    localStorageMock.setItem('sw-monitor-hidden-chains', 'not-valid-json{[');

    const ts = Date.now() + Math.random();
    const mod = await import(
      `../src/dashboard/state.ts?bust=${ts}`
    ) as typeof import('../src/dashboard/state.ts');

    expect(mod.getState().hiddenChains).toStrictEqual({});
  });

  test('non-hiddenChains setState does not overwrite localStorage key', async () => {
    await fc.assert(
      fc.asyncProperty(hiddenChainsArb, async (hiddenChains) => {
        const mod = await freshModule();

        // Write hiddenChains first
        mod.setState({ hiddenChains });
        const storedBefore = localStorageMock.getItem('sw-monitor-hidden-chains');

        // Update a different key — localStorage must remain unchanged
        mod.setState({ currentPage: 'work' });
        const storedAfter = localStorageMock.getItem('sw-monitor-hidden-chains');

        expect(storedAfter).toStrictEqual(storedBefore);
      }),
      { numRuns: 100 }
    );
  });

});
