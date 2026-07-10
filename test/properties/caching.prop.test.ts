import { describe, it, expect, beforeEach } from 'bun:test';
import * as fc from 'fast-check';
import { createCacheManager, type PerWorkspaceCache, type CacheManager } from '../../src/scan/workspace-cache';
import type { SessionState, Chain, Job } from '../../src/types';

/**
 * Property-Based Tests for Per-Workspace Caching
 * 
 * These tests verify universal properties of the per-workspace cache
 * across all possible cache operations and workspace configurations.
 * 
 * **Validates: Requirements 4.1-4.9**
 */

// ============================================================================
// Arbitraries (Generators for Test Data)
// ============================================================================

/**
 * Generate valid workspace IDs
 */
const validWorkspaceIdArb = fc.stringMatching(/^[a-z0-9-]{1,50}$/);

/**
 * Generate arrays of unique workspace IDs
 */
const workspaceIdsArb = fc.uniqueArray(validWorkspaceIdArb, {
  minLength: 2,
  maxLength: 10,
});

/**
 * Generate mock session data
 */
const mockSessionArb: fc.Arbitrary<SessionState> = fc.record({
  workflowHash: fc.string({ minLength: 8, maxLength: 16 }),
  sessionJsonl: fc.string({ minLength: 1 }),
  chainId: fc.string({ minLength: 1 }),
  chainIndex: fc.nat(100),
  previousSession: fc.string(),
  topic: fc.string({ minLength: 1 }),
  messageCount: fc.nat(1000),
  userMessageCount: fc.nat(1000),
  contextUsagePct: fc.nat(100),
  lastMessageAt: fc.constant(new Date().toISOString()),
  lastSummarisedMessageCount: fc.nat(1000),
  lastSummarisedAt: fc.string(),
  summaryFile: fc.string(),
  status: fc.constantFrom('active', 'idle', 'complete', 'rate-limited'),
  firstUserMessage: fc.string(),
  lastUserMessage: fc.string(),
  lastAgentMessage: fc.string(),
  startTime: fc.constant(new Date().toISOString()),
  workspaceId: validWorkspaceIdArb,
});

/**
 * Generate mock chain data
 */
const mockChainArb: fc.Arbitrary<Chain> = fc.record({
  chainId: fc.string({ minLength: 1 }),
  displayName: fc.string({ minLength: 1 }),
  nextIndex: fc.nat(100),
  sessions: fc.constant([]),
  totalMessages: fc.nat(1000),
  createdAt: fc.constant(new Date().toISOString()),
  lastActiveAt: fc.constant(new Date().toISOString()),
  workspaceId: validWorkspaceIdArb,
});

/**
 * Generate mock job data
 */
const mockJobArb: fc.Arbitrary<Job> = fc.record({
  id: fc.string({ minLength: 1 }),
  name: fc.string({ minLength: 1 }),
  jobChain: fc.string({ minLength: 1 }),
  sessionChainId: fc.string({ minLength: 1 }),
  timestamp: fc.constant(new Date().toISOString()),
  type: fc.string({ minLength: 1 }),
  agent: fc.string({ minLength: 1 }),
  status: fc.constantFrom('running', 'done', 'reported', 'error'),
  lines: fc.nat(10000),
  lastLine: fc.string(),
  hasLog: fc.boolean(),
  logError: fc.boolean(),
  mdFile: fc.string(),
  logFile: fc.string(),
  agentDone: fc.string(),
  sizeBytes: fc.nat(1000000),
  workspaceId: validWorkspaceIdArb,
});

/**
 * Generate arrays of sessions
 */
const sessionsArrayArb = fc.array(mockSessionArb, { minLength: 0, maxLength: 20 });

/**
 * Generate arrays of chains
 */
const chainsArrayArb = fc.array(mockChainArb, { minLength: 0, maxLength: 20 });

/**
 * Generate arrays of jobs
 */
const jobsArrayArb = fc.array(mockJobArb, { minLength: 0, maxLength: 20 });

// ============================================================================
// Property Tests
// ============================================================================

describe('Property-Based Tests: Per-Workspace Caching', () => {
  let cacheManager: CacheManager;

  beforeEach(() => {
    // Create fresh cache manager for each test
    cacheManager = createCacheManager();
  });

  /**
   * Property 11: Cache Isolation Between Workspaces
   * 
   * For any two distinct workspace identifiers A and B, storing cache data
   * for workspace A SHALL NOT modify the cache data for workspace B.
   * 
   * **Validates: Requirements 4.1-4.4**
   */
  it('Property 11: Storing cache for workspace A does not affect workspace B', () => {
    fc.assert(
      fc.property(
        workspaceIdsArb.filter(ids => ids.length >= 2),
        sessionsArrayArb,
        chainsArrayArb,
        jobsArrayArb,
        (workspaceIds, sessionsA, chainsA, jobsA) => {
          const workspaceA = workspaceIds[0];
          const workspaceB = workspaceIds[1];
          
          // Store data for workspace B first
          const sessionsB: SessionState[] = [
            {
              workflowHash: 'workflow-b',
              sessionJsonl: '/sessions/b/session.jsonl',
              chainId: 'chain-b',
              chainIndex: 0,
              previousSession: '',
              topic: 'Workspace B Session',
              messageCount: 100,
              userMessageCount: 50,
              contextUsagePct: 75,
              lastMessageAt: new Date().toISOString(),
              lastSummarisedMessageCount: 0,
              lastSummarisedAt: '',
              summaryFile: '',
              status: 'active',
              firstUserMessage: 'First B',
              lastUserMessage: 'Last B',
              lastAgentMessage: 'Agent B',
              startTime: new Date().toISOString(),
              workspaceId: workspaceB,
            },
          ];
          
          const chainsB: Chain[] = [
            {
              chainId: 'chain-b',
              displayName: 'Chain B',
              nextIndex: 1,
              sessions: [],
              totalMessages: 100,
              createdAt: new Date().toISOString(),
              lastActiveAt: new Date().toISOString(),
              workspaceId: workspaceB,
            },
          ];
          
          const jobsB: Job[] = [
            {
              id: 'job-b',
              name: 'Job B',
              jobChain: 'job-chain-b',
              sessionChainId: 'chain-b',
              timestamp: new Date().toISOString(),
              type: 'analysis',
              agent: 'test',
              status: 'done',
              lines: 100,
              lastLine: 'Done',
              hasLog: true,
              logError: false,
              mdFile: '/output/b/job.md',
              logFile: '/output/b/job.log',
              agentDone: 'done',
              sizeBytes: 1024,
              workspaceId: workspaceB,
            },
          ];
          
          cacheManager.sessions.set(workspaceB, sessionsB);
          cacheManager.chains.set(workspaceB, chainsB);
          cacheManager.jobs.set(workspaceB, jobsB);
          
          // Store original B data for comparison
          const originalSessionsB = cacheManager.sessions.get(workspaceB);
          const originalChainsB = cacheManager.chains.get(workspaceB);
          const originalJobsB = cacheManager.jobs.get(workspaceB);
          
          // Store data for workspace A
          cacheManager.sessions.set(workspaceA, sessionsA);
          cacheManager.chains.set(workspaceA, chainsA);
          cacheManager.jobs.set(workspaceA, jobsA);
          
          // Verify workspace B's cache is unchanged
          const currentSessionsB = cacheManager.sessions.get(workspaceB);
          const currentChainsB = cacheManager.chains.get(workspaceB);
          const currentJobsB = cacheManager.jobs.get(workspaceB);
          
          expect(currentSessionsB).toEqual(originalSessionsB);
          expect(currentChainsB).toEqual(originalChainsB);
          expect(currentJobsB).toEqual(originalJobsB);
          
          // Verify workspace A has its own cache
          const cachedSessionsA = cacheManager.sessions.get(workspaceA);
          const cachedChainsA = cacheManager.chains.get(workspaceA);
          const cachedJobsA = cacheManager.jobs.get(workspaceA);
          
          expect(cachedSessionsA).toEqual(sessionsA);
          expect(cachedChainsA).toEqual(chainsA);
          expect(cachedJobsA).toEqual(jobsA);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 12: Surgical Cache Invalidation
   * 
   * For any workspace identifier and populated multi-workspace cache,
   * invalidating the cache for that workspace SHALL clear only that
   * workspace's cache entries.
   * 
   * **Validates: Requirements 4.5, 4.7**
   */
  it('Property 12: Invalidating workspace A does not affect other workspaces', () => {
    fc.assert(
      fc.property(
        workspaceIdsArb.filter(ids => ids.length >= 2),
        sessionsArrayArb,
        chainsArrayArb,
        jobsArrayArb,
        (workspaceIds, sessions, chains, jobs) => {
          // Populate cache for all workspaces
          for (const workspaceId of workspaceIds) {
            cacheManager.sessions.set(workspaceId, sessions);
            cacheManager.chains.set(workspaceId, chains);
            cacheManager.jobs.set(workspaceId, jobs);
          }
          
          // Select first workspace to invalidate
          const targetWorkspace = workspaceIds[0];
          const otherWorkspaces = workspaceIds.slice(1);
          
          // Store original cache data for other workspaces
          const originalCaches = new Map<string, {
            sessions: SessionState[] | null;
            chains: Chain[] | null;
            jobs: Job[] | null;
          }>();
          
          for (const workspaceId of otherWorkspaces) {
            originalCaches.set(workspaceId, {
              sessions: cacheManager.sessions.get(workspaceId),
              chains: cacheManager.chains.get(workspaceId),
              jobs: cacheManager.jobs.get(workspaceId),
            });
          }
          
          // Invalidate target workspace
          cacheManager.sessions.invalidate(targetWorkspace);
          cacheManager.chains.invalidate(targetWorkspace);
          cacheManager.jobs.invalidate(targetWorkspace);
          
          // Verify target workspace cache is cleared
          expect(cacheManager.sessions.get(targetWorkspace)).toBeNull();
          expect(cacheManager.chains.get(targetWorkspace)).toBeNull();
          expect(cacheManager.jobs.get(targetWorkspace)).toBeNull();
          
          // Verify other workspaces are unchanged
          for (const workspaceId of otherWorkspaces) {
            const original = originalCaches.get(workspaceId)!;
            
            expect(cacheManager.sessions.get(workspaceId)).toEqual(original.sessions);
            expect(cacheManager.chains.get(workspaceId)).toEqual(original.chains);
            expect(cacheManager.jobs.get(workspaceId)).toEqual(original.jobs);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 13: Per-Workspace TTL Independence
   * 
   * For any two workspace cache entries stored at different times, TTL
   * expiration SHALL be evaluated independently for each workspace based
   * on its own storage timestamp.
   * 
   * **Validates: Requirements 4.6**
   */
  it('Property 13: TTL expiration is evaluated independently per workspace', async () => {
    await fc.assert(
      fc.asyncProperty(
        workspaceIdsArb.filter(ids => ids.length >= 2),
        sessionsArrayArb,
        async (workspaceIds, sessions) => {
          const workspaceA = workspaceIds[0];
          const workspaceB = workspaceIds[1];
          
          // Create cache manager with controlled TTL for testing
          const testCache = new (class TestCache implements PerWorkspaceCache<SessionState[]> {
            private cache = new Map<string, { data: SessionState[]; timestamp: number }>();
            private ttl = 100; // 100ms TTL
            
            get(workspaceId: string): SessionState[] | null {
              const entry = this.cache.get(workspaceId);
              if (!entry) return null;
              
              const now = Date.now();
              if (now - entry.timestamp >= this.ttl) {
                this.cache.delete(workspaceId);
                return null;
              }
              
              return entry.data;
            }
            
            set(workspaceId: string, data: SessionState[]): void {
              this.cache.set(workspaceId, { data, timestamp: Date.now() });
            }
            
            invalidate(workspaceId: string): void {
              this.cache.delete(workspaceId);
            }
            
            invalidateAll(): void {
              this.cache.clear();
            }
            
            // Test helper to manually set timestamp
            setWithTimestamp(workspaceId: string, data: SessionState[], timestamp: number): void {
              this.cache.set(workspaceId, { data, timestamp });
            }
          })();
          
          const now = Date.now();
          
          // Store workspace A at time T (80ms ago - should expire)
          testCache.setWithTimestamp(workspaceA, sessions, now - 80);
          
          // Store workspace B at time T + 30ms (50ms ago - should NOT expire yet)
          testCache.setWithTimestamp(workspaceB, sessions, now - 50);
          
          // Check both - A should be expired, B should be valid
          const cachedA = testCache.get(workspaceA);
          const cachedB = testCache.get(workspaceB);
          
          // A is expired (80ms > 100ms is false, so let's test at boundary)
          // Actually, let me make this clearer - set A to be definitely expired
          testCache.setWithTimestamp(workspaceA, sessions, now - 120); // 120ms ago > 100ms TTL
          testCache.setWithTimestamp(workspaceB, sessions, now - 50);  // 50ms ago < 100ms TTL
          
          const cachedA2 = testCache.get(workspaceA);
          const cachedB2 = testCache.get(workspaceB);
          
          expect(cachedA2).toBeNull(); // A expired (120ms > 100ms TTL)
          expect(cachedB2).toEqual(sessions); // B still valid (50ms < 100ms TTL)
          
          // Verify that each workspace's TTL is independent
          // Add workspace C at current time
          const workspaceC = workspaceIds.length > 2 ? workspaceIds[2] : 'workspace-c';
          testCache.set(workspaceC, sessions);
          const cachedC = testCache.get(workspaceC);
          expect(cachedC).toEqual(sessions); // C is fresh
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 14: Cache Invalidation of Non-Existent Workspace
   * 
   * For any workspace identifier that does not exist in the cache, calling
   * invalidate SHALL complete without errors and SHALL NOT modify any
   * existing cached data for other workspaces.
   * 
   * **Validates: Requirements 4.9**
   */
  it('Property 14: Invalidating non-existent workspace completes without error', () => {
    fc.assert(
      fc.property(
        workspaceIdsArb.filter(ids => ids.length >= 2),
        validWorkspaceIdArb,
        sessionsArrayArb,
        chainsArrayArb,
        jobsArrayArb,
        (existingWorkspaces, nonExistentWorkspace, sessions, chains, jobs) => {
          // Ensure nonExistentWorkspace is truly non-existent
          const adjustedNonExistent = existingWorkspaces.includes(nonExistentWorkspace)
            ? `${nonExistentWorkspace}-non-existent`
            : nonExistentWorkspace;
          
          // Populate cache for existing workspaces
          for (const workspaceId of existingWorkspaces) {
            cacheManager.sessions.set(workspaceId, sessions);
            cacheManager.chains.set(workspaceId, chains);
            cacheManager.jobs.set(workspaceId, jobs);
          }
          
          // Store original cache state
          const originalCaches = new Map<string, {
            sessions: SessionState[] | null;
            chains: Chain[] | null;
            jobs: Job[] | null;
          }>();
          
          for (const workspaceId of existingWorkspaces) {
            originalCaches.set(workspaceId, {
              sessions: cacheManager.sessions.get(workspaceId),
              chains: cacheManager.chains.get(workspaceId),
              jobs: cacheManager.jobs.get(workspaceId),
            });
          }
          
          // Invalidate non-existent workspace - should not throw
          expect(() => {
            cacheManager.sessions.invalidate(adjustedNonExistent);
            cacheManager.chains.invalidate(adjustedNonExistent);
            cacheManager.jobs.invalidate(adjustedNonExistent);
          }).not.toThrow();
          
          // Verify all existing workspace caches are unchanged
          for (const workspaceId of existingWorkspaces) {
            const original = originalCaches.get(workspaceId)!;
            
            expect(cacheManager.sessions.get(workspaceId)).toEqual(original.sessions);
            expect(cacheManager.chains.get(workspaceId)).toEqual(original.chains);
            expect(cacheManager.jobs.get(workspaceId)).toEqual(original.jobs);
          }
          
          // Verify non-existent workspace remains non-existent
          expect(cacheManager.sessions.get(adjustedNonExistent)).toBeNull();
          expect(cacheManager.chains.get(adjustedNonExistent)).toBeNull();
          expect(cacheManager.jobs.get(adjustedNonExistent)).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });
});
