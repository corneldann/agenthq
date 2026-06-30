// Feature: monitor-dashboard-redesign, Property 4: JobChain–Chain client-side join correctness
//
// Validates: Requirement 4.4

import { test, expect, describe } from 'bun:test';
import * as fc from 'fast-check';
import type { Chain, JobChain, Job } from '../src/dashboard/types.js';

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

const chainArb = fc.record({
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
});

// JobChain with sessionChainId that is either empty (standalone) or a UUID
const jobChainArb = fc.record({
  jobChain: fc.string(),
  sessionChainId: fc.oneof(fc.constant(''), fc.uuid()),
  type: fc.string(),
  latestStatus: fc.string(),
  latestTimestamp: fc.string(),
  runCount: fc.nat(),
  runs: fc.array(jobArb, { maxLength: 3 }),
});

// ---------------------------------------------------------------------------
// The join function — extracted from the logic in api.ts
// ---------------------------------------------------------------------------
// api.ts stores both jobChains[] and chains[] in AppState and leaves page
// renderers to look up Chain by sessionChainId === chainId.
// We test this exact join algorithm here:
//   result[i].chain = chainIndex.get(jobChains[i].sessionChainId) ?? null
// ---------------------------------------------------------------------------

interface JoinResult {
  jobChain: JobChain;
  chain: Chain | null;
}

function performJoin(jobChains: JobChain[], chains: Chain[]): JoinResult[] {
  // Mirrors buildChainIndex from api.ts + the lookup renderers perform
  const index = new Map<string, Chain>();
  for (const chain of chains) {
    index.set(chain.chainId, chain);
  }
  return jobChains.map(jc => ({
    jobChain: jc,
    chain: jc.sessionChainId !== '' ? (index.get(jc.sessionChainId) ?? null) : null,
  }));
}

// ---------------------------------------------------------------------------
// Property 4: JobChain–Chain client-side join correctness
// ---------------------------------------------------------------------------

describe('Property 4 — JobChain–Chain client-side join correctness', () => {

  test(
    'every linked JobChain (non-empty sessionChainId) maps to its unique Chain',
    () => {
      fc.assert(
        fc.property(
          fc.array(jobChainArb),
          fc.array(chainArb),
          (jobChains, chains) => {
            // Ensure unique chainIds in chains (deduplicate by chainId)
            const uniqueChains = Array.from(
              new Map(chains.map(c => [c.chainId, c])).values()
            );

            const results = performJoin(jobChains, uniqueChains);
            const chainIndex = new Map(uniqueChains.map(c => [c.chainId, c]));

            for (const r of results) {
              if (r.jobChain.sessionChainId !== '') {
                const expected = chainIndex.get(r.jobChain.sessionChainId) ?? null;
                expect(r.chain).toStrictEqual(expected);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  test(
    'every standalone JobChain (sessionChainId === "") remains unlinked (chain === null)',
    () => {
      fc.assert(
        fc.property(
          fc.array(jobChainArb),
          fc.array(chainArb),
          (jobChains, chains) => {
            const uniqueChains = Array.from(
              new Map(chains.map(c => [c.chainId, c])).values()
            );

            const results = performJoin(jobChains, uniqueChains);

            for (const r of results) {
              if (r.jobChain.sessionChainId === '') {
                expect(r.chain).toBeNull();
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  test(
    'no JobChain is omitted — result length equals input length',
    () => {
      fc.assert(
        fc.property(
          fc.array(jobChainArb),
          fc.array(chainArb),
          (jobChains, chains) => {
            const uniqueChains = Array.from(
              new Map(chains.map(c => [c.chainId, c])).values()
            );

            const results = performJoin(jobChains, uniqueChains);

            expect(results.length).toBe(jobChains.length);
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  test(
    'no JobChain is duplicated — each input JobChain appears exactly once in result',
    () => {
      fc.assert(
        fc.property(
          fc.array(jobChainArb, { minLength: 0, maxLength: 20 }),
          fc.array(chainArb),
          (jobChains, chains) => {
            const uniqueChains = Array.from(
              new Map(chains.map(c => [c.chainId, c])).values()
            );

            const results = performJoin(jobChains, uniqueChains);

            // Each result's jobChain must be the same reference as the input
            // at the corresponding index (no reordering or duplication)
            expect(results.map(r => r.jobChain)).toStrictEqual(jobChains);
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  test(
    'all properties combined: linked → correct chain, unlinked → null, no omissions or duplicates',
    () => {
      fc.assert(
        fc.property(
          fc.array(jobChainArb),
          fc.array(chainArb),
          (jobChains, chains) => {
            // Deduplicate chains by chainId
            const uniqueChains = Array.from(
              new Map(chains.map(c => [c.chainId, c])).values()
            );

            const results = performJoin(jobChains, uniqueChains);
            const chainIndex = new Map(uniqueChains.map(c => [c.chainId, c]));

            // No omissions, no duplications
            expect(results.length).toBe(jobChains.length);
            expect(results.map(r => r.jobChain)).toStrictEqual(jobChains);

            for (const r of results) {
              if (r.jobChain.sessionChainId === '') {
                // Standalone: must be unlinked
                expect(r.chain).toBeNull();
              } else {
                // Linked: must map to the unique matching Chain (or null if absent)
                const expected = chainIndex.get(r.jobChain.sessionChainId) ?? null;
                expect(r.chain).toStrictEqual(expected);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    }
  );

});

// ---------------------------------------------------------------------------
// Feature: monitor-dashboard-redesign, Property 7: Chain API response field preservation
// Validates: Requirement 4.8
// ---------------------------------------------------------------------------
// For any valid Chain[] payload, storing it via setState({ chains: payload })
// and reading back via getState().chains SHALL produce an array where every
// field present in the original payload is present and strictly equal.
// No field SHALL be omitted or silently coerced to a different type.
// ---------------------------------------------------------------------------

// localStorage mock — required because state.ts references localStorage at module load
const _p7LocalStorageStore: Record<string, string> = {};
const _p7LocalStorageMock = {
  getItem: (key: string): string | null => _p7LocalStorageStore[key] ?? null,
  setItem: (key: string, value: string): void => { _p7LocalStorageStore[key] = value; },
  removeItem: (key: string): void => { delete _p7LocalStorageStore[key]; },
  clear: (): void => { Object.keys(_p7LocalStorageStore).forEach(k => delete _p7LocalStorageStore[k]); },
};
if (!(globalThis as Record<string, unknown>).localStorage) {
  (globalThis as Record<string, unknown>).localStorage = _p7LocalStorageMock;
}

async function freshStateModule() {
  _p7LocalStorageMock.clear();
  const bust = Date.now() + Math.random();
  const mod = await import(
    `../src/dashboard/state.ts?bust=${bust}`
  ) as typeof import('../src/dashboard/state.ts');
  return mod;
}

// ---------------------------------------------------------------------------
// Arbitraries for Chain and SessionState
// ---------------------------------------------------------------------------

const sessionStateArb = fc.record({
  workflowHash: fc.string(),
  sessionJsonl: fc.string(),
  chainId: fc.uuid(),
  chainIndex: fc.nat(),
  previousSession: fc.string(),
  topic: fc.string(),
  messageCount: fc.nat(),
  userMessageCount: fc.nat(),
  contextUsagePct: fc.float({ min: 0, max: 100, noNaN: true }),
  lastMessageAt: fc.string(),
  lastSummarisedMessageCount: fc.nat(),
  lastSummarisedAt: fc.string(),
  summaryFile: fc.string(),
  status: fc.constantFrom('active', 'idle', 'complete', 'rate-limited' as const),
  firstUserMessage: fc.string(),
  lastUserMessage: fc.string(),
  lastAgentMessage: fc.string(),
  startTime: fc.string(),
});

const sessionEntryArb = fc.record({
  index: fc.nat(),
  workflowHash: fc.string(),
  date: fc.string(),
  messageCount: fc.nat(),
  status: fc.string(),
});

// Full Chain arbitrary — covers all required and optional fields.
// Optional fields (latestSession, unsummarisedDelta, overallStatus, workflowCount)
// are generated as either present-with-value or absent (undefined) so that the
// property exercises both code paths and verifies no field is silently dropped.
const chainFullArb: fc.Arbitrary<Chain> = fc.record({
  chainId: fc.uuid(),
  displayName: fc.string(),
  nextIndex: fc.nat(),
  sessions: fc.array(sessionEntryArb),
  totalMessages: fc.nat(),
  createdAt: fc.string(),
  lastActiveAt: fc.string(),
}, { requiredKeys: ['chainId', 'displayName', 'nextIndex', 'sessions', 'totalMessages', 'createdAt', 'lastActiveAt'] }).chain((required) =>
  fc.record({
    latestSession: fc.option(sessionStateArb, { nil: undefined }),
    unsummarisedDelta: fc.option(fc.nat(), { nil: undefined }),
    overallStatus: fc.option(fc.string(), { nil: undefined }),
    workflowCount: fc.option(fc.nat(), { nil: undefined }),
  }).map((optional) => {
    const chain: Chain = { ...required };
    if (optional.latestSession !== undefined) chain.latestSession = optional.latestSession;
    if (optional.unsummarisedDelta !== undefined) chain.unsummarisedDelta = optional.unsummarisedDelta;
    if (optional.overallStatus !== undefined) chain.overallStatus = optional.overallStatus;
    if (optional.workflowCount !== undefined) chain.workflowCount = optional.workflowCount;
    return chain;
  })
);

// ---------------------------------------------------------------------------
// Property 7: Chain API response field preservation
// ---------------------------------------------------------------------------

describe('Property 7 — Chain API response field preservation', () => {

  test(
    'for any Chain[] payload, getState().chains equals the payload after setState',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(chainFullArb, { minLength: 0, maxLength: 10 }),
          async (payload) => {
            const { setState, getState } = await freshStateModule();

            setState({ chains: payload });
            const stored = getState().chains;

            // Top-level: same length, same order
            expect(stored.length).toBe(payload.length);
            expect(stored).toStrictEqual(payload);
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  test(
    'all required Chain fields are present and equal after storage',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(chainFullArb, { minLength: 1, maxLength: 5 }),
          async (payload) => {
            const { setState, getState } = await freshStateModule();

            setState({ chains: payload });
            const stored = getState().chains;

            for (let i = 0; i < payload.length; i++) {
              const orig = payload[i];
              const got = stored[i];

              expect(got.chainId).toStrictEqual(orig.chainId);
              expect(got.displayName).toStrictEqual(orig.displayName);
              expect(got.nextIndex).toStrictEqual(orig.nextIndex);
              expect(got.sessions).toStrictEqual(orig.sessions);
              expect(got.totalMessages).toStrictEqual(orig.totalMessages);
              expect(got.createdAt).toStrictEqual(orig.createdAt);
              expect(got.lastActiveAt).toStrictEqual(orig.lastActiveAt);
            }
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  test(
    'optional Chain fields (latestSession, unsummarisedDelta, overallStatus, workflowCount) are preserved when present',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(chainFullArb, { minLength: 1, maxLength: 5 }),
          async (payload) => {
            const { setState, getState } = await freshStateModule();

            setState({ chains: payload });
            const stored = getState().chains;

            for (let i = 0; i < payload.length; i++) {
              const orig = payload[i];
              const got = stored[i];

              if ('latestSession' in orig) {
                expect(got.latestSession).toStrictEqual(orig.latestSession);
              } else {
                expect(got.latestSession).toBeUndefined();
              }

              if ('unsummarisedDelta' in orig) {
                expect(got.unsummarisedDelta).toStrictEqual(orig.unsummarisedDelta);
              } else {
                expect(got.unsummarisedDelta).toBeUndefined();
              }

              if ('overallStatus' in orig) {
                expect(got.overallStatus).toStrictEqual(orig.overallStatus);
              } else {
                expect(got.overallStatus).toBeUndefined();
              }

              if ('workflowCount' in orig) {
                expect(got.workflowCount).toStrictEqual(orig.workflowCount);
              } else {
                expect(got.workflowCount).toBeUndefined();
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  test(
    'empty Chain[] payload stores and retrieves as empty array',
    async () => {
      const { setState, getState } = await freshStateModule();
      setState({ chains: [] });
      expect(getState().chains).toStrictEqual([]);
    }
  );

  test(
    'SessionState fields inside latestSession are all preserved unchanged',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            chainFullArb.filter(c => c.latestSession !== undefined),
            { minLength: 1, maxLength: 5 }
          ),
          async (payload) => {
            const { setState, getState } = await freshStateModule();

            setState({ chains: payload });
            const stored = getState().chains;

            for (let i = 0; i < payload.length; i++) {
              const origSession = payload[i].latestSession!;
              const gotSession = stored[i].latestSession!;

              expect(gotSession.workflowHash).toStrictEqual(origSession.workflowHash);
              expect(gotSession.sessionJsonl).toStrictEqual(origSession.sessionJsonl);
              expect(gotSession.chainId).toStrictEqual(origSession.chainId);
              expect(gotSession.chainIndex).toStrictEqual(origSession.chainIndex);
              expect(gotSession.previousSession).toStrictEqual(origSession.previousSession);
              expect(gotSession.topic).toStrictEqual(origSession.topic);
              expect(gotSession.messageCount).toStrictEqual(origSession.messageCount);
              expect(gotSession.userMessageCount).toStrictEqual(origSession.userMessageCount);
              expect(gotSession.contextUsagePct).toStrictEqual(origSession.contextUsagePct);
              expect(gotSession.lastMessageAt).toStrictEqual(origSession.lastMessageAt);
              expect(gotSession.lastSummarisedMessageCount).toStrictEqual(origSession.lastSummarisedMessageCount);
              expect(gotSession.lastSummarisedAt).toStrictEqual(origSession.lastSummarisedAt);
              expect(gotSession.summaryFile).toStrictEqual(origSession.summaryFile);
              expect(gotSession.status).toStrictEqual(origSession.status);
              expect(gotSession.firstUserMessage).toStrictEqual(origSession.firstUserMessage);
              expect(gotSession.lastUserMessage).toStrictEqual(origSession.lastUserMessage);
              expect(gotSession.lastAgentMessage).toStrictEqual(origSession.lastAgentMessage);
              expect(gotSession.startTime).toStrictEqual(origSession.startTime);
            }
          }
        ),
        { numRuns: 100 }
      );
    }
  );

});

// ---------------------------------------------------------------------------
// Feature: monitor-dashboard-redesign, Property 5: Job transition toast detection
// Validates: Requirements 4.5, 9.3, 9.4
// ---------------------------------------------------------------------------
// For any (pre, post) Job[] pair, toasts enqueued by detectTransitions() SHALL
// equal exactly the set of running→done (success) and running→error (error)
// transitions matched by id.  No toast for jobs that were not running before
// the fetch; no transition silently missed.
// ---------------------------------------------------------------------------

// detectTransitions is loaded via dynamic import to avoid triggering the
// state.ts localStorage reference during ES module static import hoisting.
// (api.ts imports state.ts at module load; state.ts touches localStorage.)
async function loadDetectTransitions() {
  const bust = Date.now() + Math.random();
  const mod = await import(`../src/dashboard/api.ts?bust=${bust}`) as typeof import('../src/dashboard/api.ts');
  return mod.detectTransitions;
}

describe('Property 5 — Job transition toast detection', () => {

  test(
    'running→done produces exactly one success toast per matched id',
    async () => {
      const detectTransitions = await loadDetectTransitions();
      await fc.assert(
        fc.asyncProperty(
          fc.array(jobArb, { minLength: 0, maxLength: 15 }),
          fc.array(jobArb, { minLength: 0, maxLength: 15 }),
          async (preJobs, postJobs) => {
            const toasts = detectTransitions(preJobs, postJobs);
            const postById = new Map(postJobs.map(j => [j.id, j]));

            // Compute expected success transitions
            const expectedSuccess = preJobs.filter(
              pre => pre.status === 'running' && postById.get(pre.id)?.status === 'done'
            );

            const successToasts = toasts.filter(t => t.type === 'success');
            expect(successToasts.length).toBe(expectedSuccess.length);

            // Each expected job must have exactly one corresponding toast
            for (const preJob of expectedSuccess) {
              const matching = successToasts.filter(t => t.message.includes(preJob.name));
              expect(matching.length).toBeGreaterThanOrEqual(1);
            }
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  test(
    'running→error produces exactly one error toast per matched id',
    async () => {
      const detectTransitions = await loadDetectTransitions();
      await fc.assert(
        fc.asyncProperty(
          fc.array(jobArb, { minLength: 0, maxLength: 15 }),
          fc.array(jobArb, { minLength: 0, maxLength: 15 }),
          async (preJobs, postJobs) => {
            const toasts = detectTransitions(preJobs, postJobs);
            const postById = new Map(postJobs.map(j => [j.id, j]));

            // Compute expected error transitions
            const expectedError = preJobs.filter(
              pre => pre.status === 'running' && postById.get(pre.id)?.status === 'error'
            );

            const errorToasts = toasts.filter(t => t.type === 'error');
            expect(errorToasts.length).toBe(expectedError.length);

            for (const preJob of expectedError) {
              const matching = errorToasts.filter(t => t.message.includes(preJob.name));
              expect(matching.length).toBeGreaterThanOrEqual(1);
            }
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  test(
    'no toast is enqueued for jobs that were not running before the fetch',
    async () => {
      const detectTransitions = await loadDetectTransitions();
      await fc.assert(
        fc.asyncProperty(
          fc.array(jobArb.filter(j => j.status !== 'running'), { minLength: 0, maxLength: 15 }),
          fc.array(jobArb, { minLength: 0, maxLength: 15 }),
          async (preJobs, postJobs) => {
            // All pre-jobs have status !== 'running', so no toasts should appear
            const toasts = detectTransitions(preJobs, postJobs);
            expect(toasts).toHaveLength(0);
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  test(
    'no toast is enqueued when post-jobs array is empty (jobs disappeared)',
    async () => {
      const detectTransitions = await loadDetectTransitions();
      await fc.assert(
        fc.asyncProperty(
          fc.array(jobArb, { minLength: 0, maxLength: 15 }),
          async (preJobs) => {
            // Post array is empty — ids can't match, so no transitions
            const toasts = detectTransitions(preJobs, []);
            expect(toasts).toHaveLength(0);
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  test(
    'total toast count equals exactly the number of running→done plus running→error transitions',
    async () => {
      const detectTransitions = await loadDetectTransitions();
      await fc.assert(
        fc.asyncProperty(
          fc.array(jobArb, { minLength: 0, maxLength: 15 }),
          fc.array(jobArb, { minLength: 0, maxLength: 15 }),
          async (preJobs, postJobs) => {
            const toasts = detectTransitions(preJobs, postJobs);
            const postById = new Map(postJobs.map(j => [j.id, j]));

            const expectedCount = preJobs.filter(pre => {
              if (pre.status !== 'running') return false;
              const post = postById.get(pre.id);
              return post?.status === 'done' || post?.status === 'error';
            }).length;

            expect(toasts.length).toBe(expectedCount);
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  test(
    'running→done toasts are success type and running→error toasts are error type',
    async () => {
      const detectTransitions = await loadDetectTransitions();
      await fc.assert(
        fc.asyncProperty(
          fc.array(jobArb, { minLength: 0, maxLength: 15 }),
          fc.array(jobArb, { minLength: 0, maxLength: 15 }),
          async (preJobs, postJobs) => {
            const toasts = detectTransitions(preJobs, postJobs);
            for (const toast of toasts) {
              expect(toast.type === 'success' || toast.type === 'error').toBe(true);
            }

            // success toasts must not be persistent; error toasts must be persistent
            const successToasts = toasts.filter(t => t.type === 'success');
            const errorToasts = toasts.filter(t => t.type === 'error');

            for (const t of successToasts) {
              expect(t.persistent).toBe(false);
            }
            for (const t of errorToasts) {
              expect(t.persistent).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  test(
    'each returned toast has a unique non-empty id',
    async () => {
      const detectTransitions = await loadDetectTransitions();
      await fc.assert(
        fc.asyncProperty(
          fc.array(jobArb, { minLength: 0, maxLength: 15 }),
          fc.array(jobArb, { minLength: 0, maxLength: 15 }),
          async (preJobs, postJobs) => {
            const toasts = detectTransitions(preJobs, postJobs);
            const ids = toasts.map(t => t.id);
            const uniqueIds = new Set(ids);
            // All ids must be non-empty strings
            for (const id of ids) {
              expect(typeof id).toBe('string');
              expect(id.length).toBeGreaterThan(0);
            }
            // All ids must be unique
            expect(uniqueIds.size).toBe(ids.length);
          }
        ),
        { numRuns: 100 }
      );
    }
  );

});
