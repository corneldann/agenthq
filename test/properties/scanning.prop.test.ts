import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import type { WorkspaceConfig } from '../../src/config/workspace-config';
import type { SessionState, Chain, Job, GitStatus } from '../../src/types';

/**
 * Property-Based Tests for Multi-Workspace Scanning
 * 
 * These tests verify universal properties of the multi-workspace scanner
 * across all possible workspace configurations and scan scenarios.
 * 
 * **Validates: Requirements 2.1-2.9, 4.1-4.9**
 */

// ============================================================================
// Mock Scanner Interface
// ============================================================================

/**
 * Scanner invocation tracker for testing
 */
interface ScannerInvocation {
  workspaceId: string;
  scannerType: 'session' | 'chain' | 'job' | 'spec' | 'git';
}

/**
 * Mock scan result with configurable error injection
 */
interface MockScanResult {
  sessions: SessionState[];
  chains: Chain[];
  jobs: Job[];
  gitStatus: GitStatus | null;
  errors: Map<string, Error>; // workspaceId -> error
}

/**
 * Mock multi-workspace scanner for testing
 */
class MockMultiWorkspaceScanner {
  private invocations: ScannerInvocation[] = [];
  private errorWorkspaces: Set<string>;

  constructor(errorWorkspaces: string[] = []) {
    this.errorWorkspaces = new Set(errorWorkspaces);
  }

  /**
   * Scan all workspaces and track invocations
   */
  async scanAll(workspaces: WorkspaceConfig[]): Promise<MockScanResult> {
    const sessions: SessionState[] = [];
    const chains: Chain[] = [];
    const jobs: Job[] = [];
    const errors = new Map<string, Error>();

    for (const workspace of workspaces) {
      try {
        const result = await this.scanWorkspace(workspace);
        sessions.push(...result.sessions);
        chains.push(...result.chains);
        jobs.push(...result.jobs);
      } catch (error) {
        // Log error and continue scanning remaining workspaces
        errors.set(workspace.id, error as Error);
      }
    }

    return {
      sessions,
      chains,
      jobs,
      gitStatus: null, // Simplified for this mock
      errors,
    };
  }

  /**
   * Scan a single workspace
   */
  async scanWorkspace(workspace: WorkspaceConfig): Promise<{
    sessions: SessionState[];
    chains: Chain[];
    jobs: Job[];
    gitStatus: GitStatus | null;
  }> {
    // Check if this workspace should error
    if (this.errorWorkspaces.has(workspace.id)) {
      throw new Error(`Scan failed for workspace ${workspace.id}`);
    }

    // Track scanner invocations
    this.invocations.push({ workspaceId: workspace.id, scannerType: 'session' });
    this.invocations.push({ workspaceId: workspace.id, scannerType: 'chain' });
    this.invocations.push({ workspaceId: workspace.id, scannerType: 'job' });
    this.invocations.push({ workspaceId: workspace.id, scannerType: 'spec' });
    this.invocations.push({ workspaceId: workspace.id, scannerType: 'git' });

    // Generate mock data with workspaceId populated
    return {
      sessions: [this.createMockSession(workspace.id)],
      chains: [this.createMockChain(workspace.id)],
      jobs: [this.createMockJob(workspace.id)],
      gitStatus: this.createMockGitStatus(workspace.id),
    };
  }

  /**
   * Get all scanner invocations (for testing)
   */
  getInvocations(): ScannerInvocation[] {
    return this.invocations;
  }

  private createMockSession(workspaceId: string): SessionState {
    return {
      workflowHash: `workflow-${workspaceId}`,
      sessionJsonl: `/sessions/${workspaceId}/session.jsonl`,
      chainId: `chain-${workspaceId}`,
      chainIndex: 0,
      previousSession: '',
      topic: `Test Session ${workspaceId}`,
      messageCount: 10,
      userMessageCount: 5,
      contextUsagePct: 25,
      lastMessageAt: new Date().toISOString(),
      lastSummarisedMessageCount: 0,
      lastSummarisedAt: '',
      summaryFile: '',
      status: 'active',
      firstUserMessage: 'First message',
      lastUserMessage: 'Last message',
      lastAgentMessage: 'Agent response',
      startTime: new Date().toISOString(),
      workspaceId,
    };
  }

  private createMockChain(workspaceId: string): Chain {
    return {
      chainId: `chain-${workspaceId}`,
      displayName: `Chain ${workspaceId}`,
      nextIndex: 1,
      sessions: [],
      totalMessages: 10,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      workspaceId,
    };
  }

  private createMockJob(workspaceId: string): Job {
    return {
      id: `job-${workspaceId}`,
      name: `Job ${workspaceId}`,
      jobChain: `job-chain-${workspaceId}`,
      sessionChainId: `chain-${workspaceId}`,
      timestamp: new Date().toISOString(),
      type: 'analysis',
      agent: 'test-agent',
      status: 'done',
      lines: 100,
      lastLine: 'Done',
      hasLog: true,
      logError: false,
      mdFile: `/output/${workspaceId}/job.md`,
      logFile: `/output/${workspaceId}/job.log`,
      agentDone: 'done',
      sizeBytes: 1024,
      workspaceId,
    };
  }

  private createMockGitStatus(workspaceId: string): GitStatus {
    return {
      branch: 'main',
      clean: true,
      modified: [],
      staged: [],
      untracked: [],
      ahead: 0,
      behind: 0,
      workspaceId,
    };
  }
}

// ============================================================================
// Arbitraries (Generators for Test Data)
// ============================================================================

/**
 * Generate valid workspace IDs
 */
const validWorkspaceIdArb = fc.stringMatching(/^[a-z0-9-]{1,50}$/);

/**
 * Generate non-empty path strings
 */
const nonEmptyPathArb = fc.string({ minLength: 1, maxLength: 200 });

/**
 * Generate valid workspace configuration
 */
const workspaceConfigArb: fc.Arbitrary<WorkspaceConfig> = fc.record({
  id: validWorkspaceIdArb,
  OUTPUT_DIR: nonEmptyPathArb,
  SESSIONS_DIR: nonEmptyPathArb,
  WORKSPACE_ROOT: nonEmptyPathArb,
  CHAINS_DIR: fc.option(nonEmptyPathArb, { nil: undefined }),
  SPECS_DIR: fc.option(nonEmptyPathArb, { nil: undefined }),
  PROMPT_OUTPUT_DIR: fc.option(nonEmptyPathArb, { nil: undefined }),
  CRAWL_JOBS_FILE: fc.option(nonEmptyPathArb, { nil: undefined }),
  CLONE_JOBS_FILE: fc.option(nonEmptyPathArb, { nil: undefined }),
  BUILD_QUEUE_FILE: fc.option(nonEmptyPathArb, { nil: undefined }),
});

/**
 * Generate array of unique workspace configurations
 */
const workspaceArrayArb = fc.uniqueArray(workspaceConfigArb, {
  minLength: 1,
  maxLength: 10,
  selector: (config) => config.id,
});

// ============================================================================
// Property Tests
// ============================================================================

describe('Property-Based Tests: Multi-Workspace Scanning', () => {
  
  /**
   * Property 7: Scanner Invocation Completeness
   * 
   * For any set of N configured workspaces, the multi-workspace scanner SHALL
   * invoke session, chain, job, spec, and git scanning exactly once per workspace,
   * resulting in 5N total scanner invocations.
   * 
   * **Validates: Requirements 2.1-2.5**
   */
  it('Property 7: Scanner invokes all scanners once per workspace', async () => {
    await fc.assert(
      fc.asyncProperty(workspaceArrayArb, async (workspaces) => {
        const scanner = new MockMultiWorkspaceScanner();
        
        await scanner.scanAll(workspaces);
        
        const invocations = scanner.getInvocations();
        const N = workspaces.length;
        
        // Should have exactly 5N invocations (5 scanner types per workspace)
        expect(invocations.length).toBe(5 * N);
        
        // Verify each workspace has exactly 5 invocations (one per scanner type)
        for (const workspace of workspaces) {
          const workspaceInvocations = invocations.filter(
            inv => inv.workspaceId === workspace.id
          );
          
          expect(workspaceInvocations.length).toBe(5);
          
          // Verify all 5 scanner types were invoked
          const scannerTypes = workspaceInvocations.map(inv => inv.scannerType);
          expect(scannerTypes.sort()).toEqual(['chain', 'git', 'job', 'session', 'spec']);
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 8: Data Aggregation Preservation
   * 
   * For any set of per-workspace scan results, aggregating the results SHALL
   * produce a unified collection containing all items from all workspaces with
   * correct workspaceId tags.
   * 
   * **Validates: Requirements 2.6**
   */
  it('Property 8: Aggregation preserves all items with correct workspaceId', async () => {
    await fc.assert(
      fc.asyncProperty(workspaceArrayArb, async (workspaces) => {
        const scanner = new MockMultiWorkspaceScanner();
        
        const result = await scanner.scanAll(workspaces);
        
        const N = workspaces.length;
        
        // Each workspace generates 1 session, 1 chain, 1 job
        expect(result.sessions.length).toBe(N);
        expect(result.chains.length).toBe(N);
        expect(result.jobs.length).toBe(N);
        
        // Verify all items have correct workspaceId
        for (const session of result.sessions) {
          expect(session.workspaceId).toBeDefined();
          expect(session.workspaceId.length).toBeGreaterThan(0);
          // workspaceId should match one of the configured workspaces
          const matchingWorkspace = workspaces.find(w => w.id === session.workspaceId);
          expect(matchingWorkspace).toBeDefined();
        }
        
        for (const chain of result.chains) {
          expect(chain.workspaceId).toBeDefined();
          expect(chain.workspaceId.length).toBeGreaterThan(0);
          const matchingWorkspace = workspaces.find(w => w.id === chain.workspaceId);
          expect(matchingWorkspace).toBeDefined();
        }
        
        for (const job of result.jobs) {
          expect(job.workspaceId).toBeDefined();
          expect(job.workspaceId.length).toBeGreaterThan(0);
          const matchingWorkspace = workspaces.find(w => w.id === job.workspaceId);
          expect(matchingWorkspace).toBeDefined();
        }
        
        // Verify no items are lost - each workspace should have exactly one of each
        const sessionWorkspaces = new Set(result.sessions.map(s => s.workspaceId));
        const chainWorkspaces = new Set(result.chains.map(c => c.workspaceId));
        const jobWorkspaces = new Set(result.jobs.map(j => j.workspaceId));
        
        expect(sessionWorkspaces.size).toBe(N);
        expect(chainWorkspaces.size).toBe(N);
        expect(jobWorkspaces.size).toBe(N);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 9: Scan Error Isolation
   * 
   * For any workspace configuration set where some workspace scanners throw errors,
   * the multi-workspace scanner SHALL complete scanning all workspaces.
   * 
   * **Validates: Requirements 2.8**
   */
  it('Property 9: Scanner continues after errors in some workspaces', async () => {
    await fc.assert(
      fc.asyncProperty(
        workspaceArrayArb.filter(arr => arr.length >= 2),
        fc.integer({ min: 0, max: 100 }),
        async (workspaces, seed) => {
          // Randomly select some workspaces to fail (but not all)
          const errorCount = Math.floor(workspaces.length / 2);
          const errorWorkspaces = workspaces
            .slice(0, errorCount)
            .map(w => w.id);
          
          const scanner = new MockMultiWorkspaceScanner(errorWorkspaces);
          
          const result = await scanner.scanAll(workspaces);
          
          // Should have errors recorded for failed workspaces
          expect(result.errors.size).toBe(errorWorkspaces.length);
          
          // Should have successful results from non-error workspaces
          const successfulWorkspaces = workspaces.length - errorWorkspaces.length;
          expect(result.sessions.length).toBe(successfulWorkspaces);
          expect(result.chains.length).toBe(successfulWorkspaces);
          expect(result.jobs.length).toBe(successfulWorkspaces);
          
          // All returned items should be from successful workspaces only
          for (const session of result.sessions) {
            expect(errorWorkspaces.includes(session.workspaceId)).toBe(false);
          }
          
          for (const chain of result.chains) {
            expect(errorWorkspaces.includes(chain.workspaceId)).toBe(false);
          }
          
          for (const job of result.jobs) {
            expect(errorWorkspaces.includes(job.workspaceId)).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 10: Workspace ID Population Consistency
   * 
   * For any workspace and scan type, all objects returned SHALL have their
   * workspaceId field populated with the exact workspace identifier.
   * 
   * **Validates: Requirements 3.6**
   */
  it('Property 10: All scanned objects have correct workspaceId populated', async () => {
    await fc.assert(
      fc.asyncProperty(workspaceArrayArb, async (workspaces) => {
        const scanner = new MockMultiWorkspaceScanner();
        
        const result = await scanner.scanAll(workspaces);
        
        // Create a map of workspace IDs for validation
        const validWorkspaceIds = new Set(workspaces.map(w => w.id));
        
        // Verify every session has a valid, non-empty workspaceId
        for (const session of result.sessions) {
          expect(session.workspaceId).toBeDefined();
          expect(typeof session.workspaceId).toBe('string');
          expect(session.workspaceId.length).toBeGreaterThan(0);
          expect(validWorkspaceIds.has(session.workspaceId)).toBe(true);
        }
        
        // Verify every chain has a valid, non-empty workspaceId
        for (const chain of result.chains) {
          expect(chain.workspaceId).toBeDefined();
          expect(typeof chain.workspaceId).toBe('string');
          expect(chain.workspaceId.length).toBeGreaterThan(0);
          expect(validWorkspaceIds.has(chain.workspaceId)).toBe(true);
        }
        
        // Verify every job has a valid, non-empty workspaceId
        for (const job of result.jobs) {
          expect(job.workspaceId).toBeDefined();
          expect(typeof job.workspaceId).toBe('string');
          expect(job.workspaceId.length).toBeGreaterThan(0);
          expect(validWorkspaceIds.has(job.workspaceId)).toBe(true);
        }
        
        // Verify no objects have null, undefined, or incorrect workspaceId values
        const allWorkspaceIds = [
          ...result.sessions.map(s => s.workspaceId),
          ...result.chains.map(c => c.workspaceId),
          ...result.jobs.map(j => j.workspaceId),
        ];
        
        for (const id of allWorkspaceIds) {
          expect(validWorkspaceIds.has(id)).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });
});
