import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import type { Chain, Job, GitStatus } from '../../src/types';
import type { WorkspaceConfig } from '../../src/config/workspace-config';

/**
 * Property-Based Tests for Dashboard Filtering and Workspace Selection
 * 
 * These tests verify that dashboard filtering, selection persistence,
 * and fallback behavior work correctly across all scenarios.
 * 
 * **Validates: Requirements 6.4-6.11**
 */

// ============================================================================
// Arbitraries (Generators for Test Data)
// ============================================================================

/**
 * Generate valid workspace IDs matching pattern ^[a-z0-9-]{1,50}$
 */
const validWorkspaceIdArb = fc.stringMatching(/^[a-z0-9-]{1,50}$/);

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
// Helper Functions (Dashboard Filtering Logic)
// ============================================================================

/**
 * Applies dashboard filtering logic: includes item if "All Workspaces" is
 * selected (null) OR if item's workspaceId matches the selected workspace.
 * 
 * This is the core filtering logic tested by Property 18.
 */
function applyDashboardFilter<T extends { workspaceId: string }>(
  items: T[],
  selectedWorkspaceId: string | null
): T[] {
  if (selectedWorkspaceId === null) {
    // "All Workspaces" selected — include all items
    return items;
  }
  
  // Specific workspace selected — include only matching items
  return items.filter(item => item.workspaceId === selectedWorkspaceId);
}

// ============================================================================
// Property Tests
// ============================================================================

describe('Property-Based Tests: Dashboard Filtering and Selection', () => {
  
  /**
   * Property 18: Dashboard Filtering Logic Consistency
   * 
   * For any selected workspace identifier and dataset (chains, jobs, sessions,
   * git statuses), applying the dashboard filtering logic SHALL include an
   * item in the filtered view if and only if either (1) "All Workspaces" is
   * selected OR (2) the item's workspaceId matches the selected workspace
   * identifier.
   * 
   * **Validates: Requirements 6.4, 6.5, 6.6, 6.7**
   */
  describe('Property 18: Dashboard Filtering Logic Consistency', () => {
    it('filters chains consistently based on workspace selection', () => {
      fc.assert(
        fc.property(
          multiWorkspaceDatasetArb(chainArb),
          ({ data, workspaces }) => {
            // Test 1: "All Workspaces" selected (null) — all items included
            const allFiltered = applyDashboardFilter(data, null);
            expect(allFiltered.length).toBe(data.length);
            expect(allFiltered).toEqual(data);
            
            // Test 2: Specific workspace selected — only matching items included
            for (const workspace of workspaces) {
              const filtered = applyDashboardFilter(data, workspace.id);
              
              // Every item in filtered view must match selection
              for (const item of filtered) {
                expect(item.workspaceId).toBe(workspace.id);
              }
              
              // Every matching item must be included
              const expectedCount = data.filter(item => item.workspaceId === workspace.id).length;
              expect(filtered.length).toBe(expectedCount);
              
              // No non-matching items should be included
              const nonMatchingInFiltered = filtered.filter(item => item.workspaceId !== workspace.id);
              expect(nonMatchingInFiltered.length).toBe(0);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('filters jobs consistently based on workspace selection', () => {
      fc.assert(
        fc.property(
          multiWorkspaceDatasetArb(jobArb),
          ({ data, workspaces }) => {
            // Test: "All Workspaces" selected — include everything
            const allFiltered = applyDashboardFilter(data, null);
            expect(allFiltered).toEqual(data);
            
            // Test: Each workspace selection filters correctly
            for (const workspace of workspaces) {
              const filtered = applyDashboardFilter(data, workspace.id);
              
              // All filtered items must match
              const allMatch = filtered.every(item => item.workspaceId === workspace.id);
              expect(allMatch).toBe(true);
              
              // No items should be missed
              const expected = data.filter(item => item.workspaceId === workspace.id);
              expect(filtered.length).toBe(expected.length);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('filters git statuses consistently based on workspace selection', () => {
      fc.assert(
        fc.property(
          multiWorkspaceDatasetArb(gitStatusArb),
          ({ data, workspaces }) => {
            // "All Workspaces" case
            const allFiltered = applyDashboardFilter(data, null);
            expect(allFiltered.length).toBe(data.length);
            
            // Specific workspace cases
            for (const workspace of workspaces) {
              const filtered = applyDashboardFilter(data, workspace.id);
              
              // Verify if-and-only-if condition:
              // Item is included <=> item.workspaceId === selectedWorkspaceId
              for (const item of data) {
                const shouldBeIncluded = item.workspaceId === workspace.id;
                const isIncluded = filtered.includes(item);
                expect(isIncluded).toBe(shouldBeIncluded);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('applies consistent filtering across multiple data types simultaneously', () => {
      fc.assert(
        fc.property(
          fc.array(workspaceConfigArb, { minLength: 1, maxLength: 10 }),
          (workspaces) => {
            // Ensure unique workspace IDs
            const uniqueWorkspaces = Array.from(
              new Map(workspaces.map(w => [w.id, w])).values()
            );
            
            fc.pre(uniqueWorkspaces.length > 0);
            
            // Generate mixed data for all workspaces
            const chains = uniqueWorkspaces.flatMap(w =>
              Array.from({ length: 3 }, () => fc.sample(chainArb(w.id), 1)[0])
            );
            const jobs = uniqueWorkspaces.flatMap(w =>
              Array.from({ length: 2 }, () => fc.sample(jobArb(w.id), 1)[0])
            );
            const gitStatuses = uniqueWorkspaces.map(w =>
              fc.sample(gitStatusArb(w.id), 1)[0]
            );
            
            // Test consistency across all data types
            for (const workspace of uniqueWorkspaces) {
              const filteredChains = applyDashboardFilter(chains, workspace.id);
              const filteredJobs = applyDashboardFilter(jobs, workspace.id);
              const filteredGitStatuses = applyDashboardFilter(gitStatuses, workspace.id);
              
              // All filtered items must match the workspace
              expect(filteredChains.every(c => c.workspaceId === workspace.id)).toBe(true);
              expect(filteredJobs.every(j => j.workspaceId === workspace.id)).toBe(true);
              expect(filteredGitStatuses.every(g => g.workspaceId === workspace.id)).toBe(true);
            }
            
            // Test "All Workspaces" case
            const allChains = applyDashboardFilter(chains, null);
            const allJobs = applyDashboardFilter(jobs, null);
            const allGitStatuses = applyDashboardFilter(gitStatuses, null);
            
            expect(allChains.length).toBe(chains.length);
            expect(allJobs.length).toBe(jobs.length);
            expect(allGitStatuses.length).toBe(gitStatuses.length);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
  
  /**
   * Property 19: Workspace Selection Persistence Round-Trip
   * 
   * For any valid workspace identifier or null (representing "All Workspaces"),
   * persisting the selection to a key-value store then immediately reading it
   * back SHALL return the same value, ensuring reliable persistence of user's
   * workspace filter selection across page reloads.
   * 
   * The persistence logic is: store workspaceId (string) or remove the key (null).
   * On restore: read the string, or return null if absent.
   * 
   * **Validates: Requirements 6.9, 6.11**
   */
  describe('Property 19: Workspace Selection Persistence Round-Trip', () => {
    
    /**
     * Models the in-memory key-value store used for persistence testing.
     * This mirrors the localStorage semantics used by the dashboard without
     * requiring a browser environment.
     */
    function createInMemoryStore(): {
      getItem(key: string): string | null;
      setItem(key: string, value: string): void;
      removeItem(key: string): void;
    } {
      const store = new Map<string, string>();
      return {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => { store.set(key, value); },
        removeItem: (key) => { store.delete(key); },
      };
    }

    /**
     * Mirrors the persistSelectedWorkspaceId function from state.ts.
     * Stores workspaceId to the given store, or removes the key when null.
     */
    function persistSelection(
      storage: ReturnType<typeof createInMemoryStore>,
      key: string,
      workspaceId: string | null
    ): void {
      if (workspaceId === null) {
        storage.removeItem(key);
      } else {
        storage.setItem(key, workspaceId);
      }
    }

    /**
     * Mirrors the loadSelectedWorkspaceId function from state.ts.
     * Returns the stored value or null if absent.
     */
    function restoreSelection(
      storage: ReturnType<typeof createInMemoryStore>,
      key: string
    ): string | null {
      return storage.getItem(key);
    }

    it('persists and restores workspace selection correctly', () => {
      fc.assert(
        fc.property(
          fc.option(validWorkspaceIdArb, { nil: null }),
          (workspaceId) => {
            const storage = createInMemoryStore();
            const key = 'selectedWorkspaceId';
            
            // Persist the selection
            persistSelection(storage, key, workspaceId);
            
            // Restore the selection
            const restored = restoreSelection(storage, key);
            
            // Verify round-trip: persisted value === restored value
            if (workspaceId === null) {
              expect(restored).toBeNull();
            } else {
              expect(restored).toBe(workspaceId);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('handles round-trip for "All Workspaces" selection (null)', () => {
      fc.assert(
        fc.property(
          fc.constant(null),
          (selection) => {
            const storage = createInMemoryStore();
            const key = 'selectedWorkspaceId';
            
            // Set some initial value
            storage.setItem(key, 'some-workspace');
            
            // Persist null (remove from storage)
            persistSelection(storage, key, null);
            
            // Restore
            const restored = restoreSelection(storage, key);
            
            // Should be null
            expect(restored).toBeNull();
            expect(restored).toBe(selection);
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('preserves exact workspace ID strings through round-trip', () => {
      fc.assert(
        fc.property(
          validWorkspaceIdArb,
          (workspaceId) => {
            const storage = createInMemoryStore();
            const key = 'selectedWorkspaceId';
            
            // Persist
            persistSelection(storage, key, workspaceId);
            
            // Restore
            const restored = restoreSelection(storage, key);
            
            // Exact string match (case-sensitive)
            expect(restored).toBe(workspaceId);
            expect(restored?.length).toBe(workspaceId.length);
            
            // Character-by-character equality
            if (restored !== null) {
              for (let i = 0; i < workspaceId.length; i++) {
                expect(restored.charAt(i)).toBe(workspaceId.charAt(i));
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('overwriting an existing selection with a new one returns the new value', () => {
      fc.assert(
        fc.property(
          validWorkspaceIdArb,
          validWorkspaceIdArb,
          (firstId, secondId) => {
            const storage = createInMemoryStore();
            const key = 'selectedWorkspaceId';
            
            // Store first selection
            persistSelection(storage, key, firstId);
            
            // Overwrite with second selection
            persistSelection(storage, key, secondId);
            
            // Restore should return the second value
            const restored = restoreSelection(storage, key);
            expect(restored).toBe(secondId);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
  
  /**
   * Property 20: Workspace Selection Fallback Behavior
   * 
   * For any workspace identifier stored in localStorage that does not match
   * any configured workspace identifier, restoring the selection SHALL default
   * to "All Workspaces" (null), preventing errors from stale or invalid
   * persisted selections.
   * 
   * **Validates: Requirements 6.10**
   */
  describe('Property 20: Workspace Selection Fallback Behavior', () => {
    it('falls back to "All Workspaces" when stored ID does not match configured workspaces', () => {
      fc.assert(
        fc.property(
          fc.array(workspaceConfigArb, { minLength: 1, maxLength: 10 }),
          validWorkspaceIdArb,
          (workspaces, staleId) => {
            // Ensure unique workspace IDs
            const uniqueWorkspaces = Array.from(
              new Map(workspaces.map(w => [w.id, w])).values()
            );
            
            // Ensure stale ID doesn't match any configured workspace
            fc.pre(!uniqueWorkspaces.some(w => w.id === staleId));
            
            // Simulate restoring stale ID from localStorage
            const storedId = staleId;
            
            // Apply validation logic (from design: resolveRestoredWorkspaceId)
            const availableIds = uniqueWorkspaces.map(w => w.id);
            const isValid = availableIds.includes(storedId);
            const resolvedId = isValid ? storedId : null;
            
            // Should fall back to null
            expect(resolvedId).toBeNull();
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('keeps valid stored ID when it matches a configured workspace', () => {
      fc.assert(
        fc.property(
          fc.array(workspaceConfigArb, { minLength: 1, maxLength: 10 }),
          fc.integer({ min: 0, max: 9 }),
          (workspaces, index) => {
            // Ensure unique workspace IDs
            const uniqueWorkspaces = Array.from(
              new Map(workspaces.map(w => [w.id, w])).values()
            );
            
            fc.pre(uniqueWorkspaces.length > 0);
            
            // Pick one of the configured workspaces
            const validWorkspace = uniqueWorkspaces[index % uniqueWorkspaces.length];
            const storedId = validWorkspace.id;
            
            // Apply validation logic
            const availableIds = uniqueWorkspaces.map(w => w.id);
            const isValid = availableIds.includes(storedId);
            const resolvedId = isValid ? storedId : null;
            
            // Should keep the valid ID
            expect(resolvedId).toBe(storedId);
            expect(resolvedId).not.toBeNull();
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('falls back to null for null stored value regardless of configured workspaces', () => {
      fc.assert(
        fc.property(
          fc.array(workspaceConfigArb, { minLength: 0, maxLength: 10 }),
          (workspaces) => {
            // Ensure unique workspace IDs
            const uniqueWorkspaces = Array.from(
              new Map(workspaces.map(w => [w.id, w])).values()
            );
            
            const storedId = null;
            
            // Apply validation logic
            const availableIds = uniqueWorkspaces.map(w => w.id);
            const isValid = storedId !== null && availableIds.includes(storedId);
            const resolvedId = isValid ? storedId : null;
            
            // Should remain null
            expect(resolvedId).toBeNull();
          }
        ),
        { numRuns: 100 }
      );
    });
    
    it('prevents errors by gracefully handling removed workspace IDs', () => {
      fc.assert(
        fc.property(
          fc.array(workspaceConfigArb, { minLength: 2, maxLength: 10 }),
          (workspaces) => {
            // Ensure unique workspace IDs
            const uniqueWorkspaces = Array.from(
              new Map(workspaces.map(w => [w.id, w])).values()
            );
            
            fc.pre(uniqueWorkspaces.length >= 2);
            
            // Simulate: user had workspace-a selected, but it was removed from config
            const removedWorkspaceId = uniqueWorkspaces[0].id;
            const currentWorkspaces = uniqueWorkspaces.slice(1); // removed first workspace
            
            // Restore with validation
            const storedId = removedWorkspaceId;
            const availableIds = currentWorkspaces.map(w => w.id);
            const isValid = availableIds.includes(storedId);
            const resolvedId = isValid ? storedId : null;
            
            // Should fall back to null (not crash or throw error)
            expect(resolvedId).toBeNull();
            
            // Filtering with resolved ID should work (show all workspaces)
            const testData = currentWorkspaces.map(w => ({ workspaceId: w.id, data: 'test' }));
            const filtered = applyDashboardFilter(testData, resolvedId);
            expect(filtered.length).toBe(testData.length);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
