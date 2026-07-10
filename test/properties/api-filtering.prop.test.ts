import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import type { WorkspaceConfig } from '../../src/config/workspace-config';
import { filterByWorkspace, validateWorkspaceId } from '../../src/routes/helpers/filter';
import type { Chain, Job, SessionState, GitStatus, BuildQueueRecord } from '../../src/types';

/**
 * Property-Based Tests for API Filtering
 * 
 * These tests verify that workspace filtering behaves correctly across all API routes:
 * - /chains, /jobs, /sessions, /git-status, /build-queue
 * 
 * Properties test universal invariants that must hold for any combination of:
 * - Datasets with various workspaceId tags
 * - Valid/invalid workspace identifiers
 * - Presence/absence of data for valid workspaces
 * 
 * **Validates: Requirements 5.1-5.20, 8.6-8.7**
 */

// ============================================================================
// Arbitraries (Generators for Test Data)
// ============================================================================

/**
 * Generate valid workspace IDs matching pattern ^[a-z0-9-]{1,50}$
 */
const validWorkspaceIdArb = fc.stringMatching(/^[a-z0-9-]{1,50}$/);

/**
 * Generate invalid workspace IDs that don't match any configured workspace
 */
const invalidWorkspaceIdArb = fc.oneof(
  // Random strings that don't match pattern
  fc.string({ minLength: 1, maxLength: 20 }).filter(s => !/^[a-z0-9-]{1,50}$/.test(s)),
  // Valid pattern but with suffix to ensure it doesn't match
  fc.stringMatching(/^[a-z0-9-]{1,40}$/).map(s => s + '-nonexistent-xyz123')
);

/**
 * Generate WorkspaceConfig objects
 */
const workspaceConfigArb: fc.Arbitrary<WorkspaceConfig> = fc.record({
  id: validWorkspaceIdArb,
  OUTPUT_DIR: fc.constant('/test/output'),
  SESSIONS_DIR: fc.constant('/test/sessions'),
  WORKSPACE_ROOT: fc.constant('/test/root'),
  CHAINS_DIR: fc.constant('/test/chains'),
  PROMPT_OUTPUT_DIR: fc.constant('/test/output'),
});

/**
 * Generate Chain objects with workspace identification
 */
const chainArb = (workspaceId: string): fc.Arbitrary<Chain> => fc.record({
  chainId: fc.uuid(),
  displayName: fc.string({ minLength: 5, maxLength: 30 }),
  nextIndex: fc.integer({ min: 0, max: 100 }),
  sessions: fc.array(fc.record({
    index: fc.integer({ min: 0, max: 50 }),
    workflowHash: fc.string({ minLength: 8, maxLength: 16 }),
    date: fc.constant(new Date().toISOString()),
    messageCount: fc.integer({ min: 1, max: 100 }),
    status: fc.constantFrom('active', 'idle', 'complete'),
  }), { minLength: 1, maxLength: 10 }),
  totalMessages: fc.integer({ min: 2, max: 1000 }),
  createdAt: fc.constant(new Date().toISOString()),
  lastActiveAt: fc.constant(new Date().toISOString()),
  workspaceId: fc.constant(workspaceId),
});

/**
 * Generate Job objects with workspace identification
 */
const jobArb = (workspaceId: string): fc.Arbitrary<Job> => fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 5, maxLength: 30 }),
  jobChain: fc.string({ minLength: 5, maxLength: 30 }),
  sessionChainId: fc.uuid(),
  timestamp: fc.constant(new Date().toISOString()),
  type: fc.constantFrom('crawl', 'clone', 'summarise', 'build'),
  agent: fc.constantFrom('agent1', 'agent2', 'agent3'),
  status: fc.constantFrom('running', 'done', 'reported', 'error'),
  lines: fc.integer({ min: 0, max: 10000 }),
  lastLine: fc.string({ maxLength: 100 }),
  hasLog: fc.boolean(),
  logError: fc.boolean(),
  mdFile: fc.string({ maxLength: 100 }),
  logFile: fc.string({ maxLength: 100 }),
  agentDone: fc.constant(new Date().toISOString()),
  sizeBytes: fc.integer({ min: 0, max: 1000000 }),
  workspaceId: fc.constant(workspaceId),
});

/**
 * Generate SessionState objects with workspace identification
 */
const sessionArb = (workspaceId: string): fc.Arbitrary<SessionState> => fc.record({
  workflowHash: fc.string({ minLength: 8, maxLength: 16 }),
  sessionJsonl: fc.string({ maxLength: 100 }),
  chainId: fc.uuid(),
  chainIndex: fc.integer({ min: 0, max: 100 }),
  previousSession: fc.string({ maxLength: 50 }),
  topic: fc.string({ minLength: 5, maxLength: 50 }),
  messageCount: fc.integer({ min: 1, max: 1000 }),
  userMessageCount: fc.integer({ min: 1, max: 500 }),
  contextUsagePct: fc.integer({ min: 0, max: 100 }),
  lastMessageAt: fc.constant(new Date().toISOString()),
  lastSummarisedMessageCount: fc.integer({ min: 0, max: 1000 }),
  lastSummarisedAt: fc.constant(new Date().toISOString()),
  summaryFile: fc.string({ maxLength: 100 }),
  status: fc.constantFrom('active', 'idle', 'complete', 'rate-limited'),
  firstUserMessage: fc.string({ minLength: 5, maxLength: 100 }),
  lastUserMessage: fc.string({ minLength: 5, maxLength: 100 }),
  lastAgentMessage: fc.string({ minLength: 5, maxLength: 100 }),
  startTime: fc.constant(new Date().toISOString()),
  chatSessionId: fc.option(fc.uuid(), { nil: undefined }),
  workspaceId: fc.constant(workspaceId),
});

/**
 * Generate GitStatus objects with workspace identification
 */
const gitStatusArb = (workspaceId: string): fc.Arbitrary<GitStatus> => fc.record({
  branch: fc.constantFrom('main', 'master', 'develop', 'feature/test'),
  clean: fc.boolean(),
  modified: fc.array(fc.string({ minLength: 5, maxLength: 50 }), { maxLength: 10 }),
  staged: fc.array(fc.string({ minLength: 5, maxLength: 50 }), { maxLength: 10 }),
  untracked: fc.array(fc.string({ minLength: 5, maxLength: 50 }), { maxLength: 10 }),
  ahead: fc.integer({ min: 0, max: 10 }),
  behind: fc.integer({ min: 0, max: 10 }),
  workspaceId: fc.constant(workspaceId),
});

/**
 * Generate BuildQueueRecord objects with workspace identification
 */
const buildQueueRecordArb = (workspaceId: string): fc.Arbitrary<BuildQueueRecord> => fc.record({
  target: fc.constant('dashboard' as const),
  ts: fc.integer({ min: Date.now() - 86400000, max: Date.now() }),
  status: fc.constantFrom('pending', 'building', 'done', 'error'),
  stem: fc.string({ minLength: 10, maxLength: 50 }),
  workspaceId: fc.constant(workspaceId),
});

/**
 * Generate a dataset with items from multiple workspaces
 */
function multiWorkspaceDatasetArb<T>(
  itemArb: (workspaceId: string) => fc.Arbitrary<T>
): fc.Arbitrary<{ data: T[], workspaces: WorkspaceConfig[] }> {
  return fc.array(workspaceConfigArb, { minLength: 1, maxLength: 10 })
    .chain(workspaces => {
      // Ensure unique workspace IDs
      const uniqueWorkspaces = Array.from(
        new Map(workspaces.map(w => [w.id, w])).values()
      );
      
      // Generate items for each workspace
      const itemsArb = fc.array(
        fc.oneof(
          ...uniqueWorkspaces.map(w => itemArb(w.id))
        ),
        { minLength: 0, maxLength: 50 }
      );
      
      return itemsArb.map(data => ({ data, workspaces: uniqueWorkspaces }));
    });
}

// ============================================================================
// Property Tests
// ============================================================================

describe('Property-Based Tests: API Filtering', () => {
  
  /**
   * Property 15: API Filtering Correctness
   * 
   * For any dataset with items tagged with various workspaceId values,
   * querying with a workspaceId filter SHALL return only items where the
   * workspaceId field exactly matches the filter value (case-sensitive),
   * and querying without a filter SHALL return all items regardless of workspaceId.
   * 
   * **Validates: Requirements 5.1-5.3, 5.5-5.8, 5.10-5.13, 5.15-5.18, 5.20, 8.6-8.7**
   */
  describe('Property 15: API Filtering Correctness', () => {
    it('filters chains correctly by workspaceId', () => {
      fc.assert(
        fc.property(
          multiWorkspaceDatasetArb(chainArb),
          ({ data, workspaces }) => {
            // Test: No filter returns all items
            const allResult = filterByWorkspace(data, undefined, workspaces);
            expect(allResult.status).toBe(200);
            expect(allResult.data).toEqual(data);
            expect(allResult.data?.length).toBe(data.length);
            
            // Test: Filter by each workspace returns only matching items
            for (const workspace of workspaces) {
              const filteredResult = filterByWorkspace(data, workspace.id, workspaces);
              expect(filteredResult.status).toBe(200);
              
              // All returned items must match the filter (case-sensitive)
              const filtered = filteredResult.data || [];
              for (const item of filtered) {
                expect(item.workspaceId).toBe(workspace.id);
              }
              
              // All matching items must be returned
              const expectedCount = data.filter(item => item.workspaceId === workspace.id).length;
              expect(filtered.length).toBe(expectedCount);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('filters jobs correctly by workspaceId', () => {
      fc.assert(
        fc.property(
          multiWorkspaceDatasetArb(jobArb),
          ({ data, workspaces }) => {
            // Test: No filter returns all items
            const allResult = filterByWorkspace(data, null, workspaces);
            expect(allResult.status).toBe(200);
            expect(allResult.data?.length).toBe(data.length);
            
            // Test: Filter by each workspace returns only matching items
            for (const workspace of workspaces) {
              const filteredResult = filterByWorkspace(data, workspace.id, workspaces);
              expect(filteredResult.status).toBe(200);
              
              const filtered = filteredResult.data || [];
              
              // Verify case-sensitive exact string matching
              for (const item of filtered) {
                expect(item.workspaceId).toBe(workspace.id);
              }
              
              // Verify completeness
              const expectedCount = data.filter(item => item.workspaceId === workspace.id).length;
              expect(filtered.length).toBe(expectedCount);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('filters sessions correctly by workspaceId', () => {
      fc.assert(
        fc.property(
          multiWorkspaceDatasetArb(sessionArb),
          ({ data, workspaces }) => {
            // Test: Omitted filter returns all items
            const allResult = filterByWorkspace(data, undefined, workspaces);
            expect(allResult.status).toBe(200);
            expect(allResult.data).toEqual(data);
            
            // Test: Filter by workspace returns only matching items
            for (const workspace of workspaces) {
              const filteredResult = filterByWorkspace(data, workspace.id, workspaces);
              
              // All returned items must have matching workspaceId
              const filtered = filteredResult.data || [];
              const allMatch = filtered.every(item => item.workspaceId === workspace.id);
              expect(allMatch).toBe(true);
              
              // Count must match expected
              const expected = data.filter(item => item.workspaceId === workspace.id);
              expect(filtered.length).toBe(expected.length);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('filters git statuses correctly by workspaceId', () => {
      fc.assert(
        fc.property(
          multiWorkspaceDatasetArb(gitStatusArb),
          ({ data, workspaces }) => {
            // Test: No filter returns all items
            const allResult = filterByWorkspace(data, undefined, workspaces);
            expect(allResult.status).toBe(200);
            expect(allResult.data?.length).toBe(data.length);
            
            // Test: Filtered results only contain matching items
            for (const workspace of workspaces) {
              const filteredResult = filterByWorkspace(data, workspace.id, workspaces);
              expect(filteredResult.status).toBe(200);
              
              const filtered = filteredResult.data || [];
              
              // Case-sensitive exact match verification
              for (const item of filtered) {
                expect(item.workspaceId).toBe(workspace.id);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('filters build queue records correctly by workspaceId', () => {
      fc.assert(
        fc.property(
          multiWorkspaceDatasetArb(buildQueueRecordArb),
          ({ data, workspaces }) => {
            // Test: No filter returns all
            const allResult = filterByWorkspace(data, undefined, workspaces);
            expect(allResult.status).toBe(200);
            expect(allResult.data).toEqual(data);
            
            // Test: Each workspace filter works correctly
            for (const workspace of workspaces) {
              const result = filterByWorkspace(data, workspace.id, workspaces);
              
              const filtered = result.data || [];
              
              // Every item must match
              expect(filtered.every(item => item.workspaceId === workspace.id)).toBe(true);
              
              // No items missed
              const expected = data.filter(item => item.workspaceId === workspace.id);
              expect(filtered.length).toBe(expected.length);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
  
  /**
   * Property 16: API Invalid Workspace Response
   * 
   * For any workspace identifier that does not match any configured workspace,
   * querying any API route with that workspaceId filter SHALL return HTTP 404
   * status with an error message indicating the workspace does not exist.
   * 
   * **Validates: Requirements 5.4, 5.9, 5.14, 5.19**
   */
  describe('Property 16: API Invalid Workspace Response', () => {
    it('returns 404 for invalid workspace IDs across all data types', () => {
      fc.assert(
        fc.property(
          fc.array(workspaceConfigArb, { minLength: 1, maxLength: 10 }),
          invalidWorkspaceIdArb,
          fc.constantFrom('chain', 'job', 'session', 'git', 'queue'),
          (workspaces, invalidId, dataType) => {
            // Ensure unique workspace IDs
            const uniqueWorkspaces = Array.from(
              new Map(workspaces.map(w => [w.id, w])).values()
            );
            
            // Ensure the invalid ID doesn't accidentally match a configured workspace
            fc.pre(!uniqueWorkspaces.some(w => w.id === invalidId));
            
            // Create empty dataset (result should be 404 regardless of data)
            const emptyData: any[] = [];
            
            // Test filtering with invalid workspace ID
            const result = filterByWorkspace(emptyData, invalidId, uniqueWorkspaces);
            
            // Must return 404 status
            expect(result.status).toBe(404);
            
            // Must include error message
            expect(result.error).toBeDefined();
            expect(result.error).toContain('does not exist');
            expect(result.error).toContain(invalidId);
            
            // Must not return data
            expect(result.data).toBeUndefined();
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('validates workspace ID correctly', () => {
      fc.assert(
        fc.property(
          fc.array(workspaceConfigArb, { minLength: 1, maxLength: 10 }),
          invalidWorkspaceIdArb,
          (workspaces, invalidId) => {
            // Ensure unique workspace IDs
            const uniqueWorkspaces = Array.from(
              new Map(workspaces.map(w => [w.id, w])).values()
            );
            
            // Ensure the invalid ID doesn't match any configured workspace
            fc.pre(!uniqueWorkspaces.some(w => w.id === invalidId));
            
            // Invalid ID should not validate
            const isValid = validateWorkspaceId(invalidId, uniqueWorkspaces);
            expect(isValid).toBe(false);
            
            // All configured workspace IDs should validate
            for (const workspace of uniqueWorkspaces) {
              const shouldBeValid = validateWorkspaceId(workspace.id, uniqueWorkspaces);
              expect(shouldBeValid).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
  
  /**
   * Property 17: API Empty Result for Valid Workspace
   * 
   * For any configured workspace identifier with no data of the queried type,
   * querying an API route with that workspaceId filter SHALL return HTTP 200
   * status with an empty array, distinguishing between "workspace exists but
   * has no data" (200, []) and "workspace does not exist" (404, error).
   * 
   * **Validates: Requirements 5.4.1, 5.9.1, 5.14.1, 5.19.1**
   */
  describe('Property 17: API Empty Result for Valid Workspace', () => {
    it('returns 200 with empty array for valid workspace with no chains', () => {
      fc.assert(
        fc.property(
          multiWorkspaceDatasetArb(chainArb),
          fc.integer({ min: 0, max: 9 }),
          ({ data, workspaces }, workspaceIndex) => {
            fc.pre(workspaces.length > 0);
            
            const targetWorkspace = workspaces[workspaceIndex % workspaces.length];
            
            // Filter out all data for the target workspace to simulate "no data"
            const dataWithoutTarget = data.filter(item => item.workspaceId !== targetWorkspace.id);
            
            // Query for the target workspace
            const result = filterByWorkspace(dataWithoutTarget, targetWorkspace.id, workspaces);
            
            // Should return 200 (workspace exists)
            expect(result.status).toBe(200);
            
            // Should return empty array (no data for this workspace)
            expect(result.data).toBeDefined();
            expect(result.data).toEqual([]);
            expect(result.data?.length).toBe(0);
            
            // Should NOT have error message
            expect(result.error).toBeUndefined();
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('returns 200 with empty array for valid workspace with no jobs', () => {
      fc.assert(
        fc.property(
          fc.array(workspaceConfigArb, { minLength: 1, maxLength: 10 }),
          fc.array(jobArb('other-workspace'), { minLength: 0, maxLength: 20 }),
          (workspaces, jobs) => {
            // Ensure unique workspace IDs
            const uniqueWorkspaces = Array.from(
              new Map(workspaces.map(w => [w.id, w])).values()
            );
            
            fc.pre(uniqueWorkspaces.length > 0);
            
            // Pick first workspace
            const targetWorkspace = uniqueWorkspaces[0];
            
            // Ensure no jobs belong to target workspace
            fc.pre(jobs.every(job => job.workspaceId !== targetWorkspace.id));
            
            // Query for target workspace
            const result = filterByWorkspace(jobs, targetWorkspace.id, uniqueWorkspaces);
            
            // Must return 200 status (workspace exists)
            expect(result.status).toBe(200);
            
            // Must return empty array (no data)
            expect(Array.isArray(result.data)).toBe(true);
            expect(result.data?.length).toBe(0);
            
            // Must not have error
            expect(result.error).toBeUndefined();
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('returns 200 with empty array for valid workspace with no sessions', () => {
      fc.assert(
        fc.property(
          multiWorkspaceDatasetArb(sessionArb),
          (dataset) => {
            const { workspaces } = dataset;
            
            fc.pre(workspaces.length > 0);
            
            const targetWorkspace = workspaces[0];
            
            // Create dataset with no sessions for target workspace
            const sessionsWithoutTarget = dataset.data.filter(
              s => s.workspaceId !== targetWorkspace.id
            );
            
            const result = filterByWorkspace(sessionsWithoutTarget, targetWorkspace.id, workspaces);
            
            // Valid workspace, no data → 200 with empty array
            expect(result.status).toBe(200);
            expect(result.data).toEqual([]);
            expect(result.error).toBeUndefined();
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('returns 200 with empty array for valid workspace with no git status', () => {
      fc.assert(
        fc.property(
          fc.array(workspaceConfigArb, { minLength: 2, maxLength: 10 }),
          (workspaces) => {
            // Ensure unique workspace IDs
            const uniqueWorkspaces = Array.from(
              new Map(workspaces.map(w => [w.id, w])).values()
            );
            
            fc.pre(uniqueWorkspaces.length >= 2);
            
            // Create git statuses for all workspaces except the first
            const gitStatuses = uniqueWorkspaces.slice(1).map(w => ({
              branch: 'main',
              clean: true,
              modified: [],
              staged: [],
              untracked: [],
              ahead: 0,
              behind: 0,
              workspaceId: w.id,
            }));
            
            const targetWorkspace = uniqueWorkspaces[0];
            
            // Query for workspace with no git status
            const result = filterByWorkspace(gitStatuses, targetWorkspace.id, uniqueWorkspaces);
            
            // Valid workspace, no data → 200 with []
            expect(result.status).toBe(200);
            expect(result.data).toEqual([]);
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('returns 200 with empty array for valid workspace with no queue records', () => {
      fc.assert(
        fc.property(
          multiWorkspaceDatasetArb(buildQueueRecordArb),
          fc.integer({ min: 0, max: 9 }),
          ({ data, workspaces }, idx) => {
            fc.pre(workspaces.length > 0);
            
            const targetWorkspace = workspaces[idx % workspaces.length];
            
            // Remove all queue records for target workspace
            const recordsWithoutTarget = data.filter(r => r.workspaceId !== targetWorkspace.id);
            
            const result = filterByWorkspace(recordsWithoutTarget, targetWorkspace.id, workspaces);
            
            // Should distinguish: workspace exists (200) but no data ([])
            expect(result.status).toBe(200);
            expect(result.data).toEqual([]);
            expect(result.error).toBeUndefined();
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('distinguishes between "workspace not found" (404) and "no data" (200)', () => {
      fc.assert(
        fc.property(
          fc.array(workspaceConfigArb, { minLength: 1, maxLength: 10 }),
          invalidWorkspaceIdArb,
          fc.array(chainArb('workspace-a'), { minLength: 0, maxLength: 10 }),
          (workspaces, invalidId, chains) => {
            // Ensure unique workspace IDs
            const uniqueWorkspaces = Array.from(
              new Map(workspaces.map(w => [w.id, w])).values()
            );
            
            fc.pre(uniqueWorkspaces.length > 0);
            fc.pre(!uniqueWorkspaces.some(w => w.id === invalidId));
            
            const validWorkspace = uniqueWorkspaces[0];
            
            // Remove all chains for valid workspace
            const chainsWithoutValid = chains.filter(c => c.workspaceId !== validWorkspace.id);
            
            // Valid workspace with no data → 200 with []
            const validResult = filterByWorkspace(chainsWithoutValid, validWorkspace.id, uniqueWorkspaces);
            expect(validResult.status).toBe(200);
            expect(validResult.data).toEqual([]);
            expect(validResult.error).toBeUndefined();
            
            // Invalid workspace → 404 with error
            const invalidResult = filterByWorkspace(chainsWithoutValid, invalidId, uniqueWorkspaces);
            expect(invalidResult.status).toBe(404);
            expect(invalidResult.error).toBeDefined();
            expect(invalidResult.data).toBeUndefined();
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
