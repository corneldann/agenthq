// Feature: multi-workspace-monitoring, Task 4.6 — Integration tests for filesystem path handling
//
// Tests scanner reads from workspace-specific paths and handles mixed valid/invalid workspaces.
// Validates: Requirements 1.12, 1.13, 2.7, 2.8

import { test, expect, describe, afterEach, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { scanChains, invalidateChainsCache } from '../../src/scan/chains.ts';
import { scanSessions, invalidateSessionsCache } from '../../src/scan/sessions.ts';
import { scanJobs } from '../../src/scan/jobs.ts';
import { DefaultConfigurationLoader } from '../../src/config/workspace-config.ts';
import type { WorkspaceConfig } from '../../src/config/workspace-config.ts';
import type { Chain, SessionState, Job } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// Test fixtures and helpers
// ---------------------------------------------------------------------------

const TEST_BASE_DIR = join(import.meta.dir, '../fixtures/integration-filesystem');

/**
 * Create a minimal valid workspace directory structure
 */
function createWorkspaceDirectories(workspaceId: string): {
  OUTPUT_DIR: string;
  SESSIONS_DIR: string;
  WORKSPACE_ROOT: string;
} {
  const baseDir = join(TEST_BASE_DIR, workspaceId);
  const OUTPUT_DIR = join(baseDir, 'output');
  const SESSIONS_DIR = join(baseDir, '.kiro', 'sessions');
  const WORKSPACE_ROOT = baseDir;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });

  return { OUTPUT_DIR, SESSIONS_DIR, WORKSPACE_ROOT };
}

/**
 * Create a minimal valid chain.json file
 */
function createChainFile(sessionsDir: string, chainId: string): void {
  const chainDir = join(sessionsDir, chainId);
  mkdirSync(chainDir, { recursive: true });

  const chainData: Chain = {
    chainId,
    displayName: chainId.replace(/-/g, ' '),
    nextIndex: 1,
    sessions: [
      {
        index: 0,
        workflowHash: `wh-${chainId}-0`,
        date: '2026-01-15T10:00:00Z',
        messageCount: 5,
        status: 'idle',
      },
    ],
    totalMessages: 5,
    createdAt: '2026-01-15T10:00:00Z',
    lastActiveAt: '2026-01-15T10:00:00Z',
    workspaceId: 'default',
  };

  writeFileSync(join(chainDir, 'chain.json'), JSON.stringify(chainData, null, 2));
}

/**
 * Create a minimal valid session state file
 */
function createSessionFile(sessionsDir: string, chainId: string, workflowHash: string): void {
  const stateDir = join(sessionsDir, `2026-01-15_${chainId}`, 'State');
  mkdirSync(stateDir, { recursive: true });

  const sessionData: SessionState = {
    workflowHash,
    sessionJsonl: `${workflowHash}.jsonl`,
    chainId,
    chainIndex: 0,
    previousSession: '',
    topic: 'Test Session',
    messageCount: 5,
    userMessageCount: 3,
    contextUsagePct: 25.5,
    lastMessageAt: '2026-01-15T10:00:00Z',
    lastSummarisedMessageCount: 0,
    lastSummarisedAt: '',
    summaryFile: '',
    status: 'idle',
    firstUserMessage: 'Test message',
    lastUserMessage: 'Last test message',
    lastAgentMessage: 'Agent response',
    startTime: '2026-01-15T09:00:00Z',
    chatSessionId: `chat-${workflowHash}`,
    workspaceId: 'default',
  };

  writeFileSync(join(stateDir, `${workflowHash}.json`), JSON.stringify(sessionData, null, 2));
}

/**
 * Create a minimal valid job output file
 */
function createJobFile(outputDir: string, jobId: string): void {
  const content = `# Job: ${jobId}

---
type: test
agent: test-agent
source: test-source
---

Job output content for ${jobId}
`;

  writeFileSync(join(outputDir, `${jobId}.md`), content);
}

// ---------------------------------------------------------------------------
// Setup and Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Ensure clean state before each test
  if (existsSync(TEST_BASE_DIR)) {
    rmSync(TEST_BASE_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_BASE_DIR, { recursive: true });
  
  // Clear scanner caches to ensure tests are isolated
  invalidateChainsCache();
  invalidateSessionsCache();
});

afterEach(() => {
  // Clean up after each test
  if (existsSync(TEST_BASE_DIR)) {
    rmSync(TEST_BASE_DIR, { recursive: true, force: true });
  }
  
  // Clear scanner caches
  invalidateChainsCache();
  invalidateSessionsCache();
});

// ---------------------------------------------------------------------------
// Requirement 1.12: Validate required directory paths exist on filesystem
// ---------------------------------------------------------------------------

describe('Requirement 1.12: Path validation before loading workspace', () => {
  test('validateWorkspace returns true when all required paths exist', async () => {
    const dirs = createWorkspaceDirectories('workspace-valid');
    const loader = new DefaultConfigurationLoader();

    const config: WorkspaceConfig = {
      id: 'workspace-valid',
      ...dirs,
    };

    const isValid = await loader.validateWorkspace(config);
    expect(isValid).toBe(true);
  });

  test('validateWorkspace returns false when OUTPUT_DIR does not exist', async () => {
    const dirs = createWorkspaceDirectories('workspace-invalid-output');
    const loader = new DefaultConfigurationLoader();

    // Remove OUTPUT_DIR
    rmSync(dirs.OUTPUT_DIR, { recursive: true, force: true });

    const config: WorkspaceConfig = {
      id: 'workspace-invalid-output',
      ...dirs,
    };

    const isValid = await loader.validateWorkspace(config);
    expect(isValid).toBe(false);
  });

  test('validateWorkspace returns false when SESSIONS_DIR does not exist', async () => {
    const dirs = createWorkspaceDirectories('workspace-invalid-sessions');
    const loader = new DefaultConfigurationLoader();

    // Remove SESSIONS_DIR
    rmSync(dirs.SESSIONS_DIR, { recursive: true, force: true });

    const config: WorkspaceConfig = {
      id: 'workspace-invalid-sessions',
      ...dirs,
    };

    const isValid = await loader.validateWorkspace(config);
    expect(isValid).toBe(false);
  });

  test('validateWorkspace returns false when WORKSPACE_ROOT does not exist', async () => {
    const dirs = createWorkspaceDirectories('workspace-invalid-root');
    const loader = new DefaultConfigurationLoader();

    const config: WorkspaceConfig = {
      id: 'workspace-invalid-root',
      OUTPUT_DIR: dirs.OUTPUT_DIR,
      SESSIONS_DIR: dirs.SESSIONS_DIR,
      WORKSPACE_ROOT: join(TEST_BASE_DIR, 'non-existent-root'),
    };

    const isValid = await loader.validateWorkspace(config);
    expect(isValid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Requirement 1.13: Skip workspace with non-existent paths and continue loading
// ---------------------------------------------------------------------------

describe('Requirement 1.13: Configuration loader skips invalid workspaces and continues', () => {
  test('loadWorkspaces skips workspace with missing required path and continues with valid ones', async () => {
    const workspace1Dirs = createWorkspaceDirectories('workspace-1-valid');
    const workspace2Dirs = createWorkspaceDirectories('workspace-2-invalid');
    const workspace3Dirs = createWorkspaceDirectories('workspace-3-valid');

    // Remove OUTPUT_DIR from workspace-2 to make it invalid
    rmSync(workspace2Dirs.OUTPUT_DIR, { recursive: true, force: true });

    const configPath = join(TEST_BASE_DIR, 'workspaces.json');
    const configData = {
      workspaces: [
        {
          id: 'workspace-1-valid',
          ...workspace1Dirs,
        },
        {
          id: 'workspace-2-invalid',
          ...workspace2Dirs,
        },
        {
          id: 'workspace-3-valid',
          ...workspace3Dirs,
        },
      ],
    };

    writeFileSync(configPath, JSON.stringify(configData, null, 2));

    const loader = new DefaultConfigurationLoader(configPath);
    const workspaces = await loader.loadWorkspaces();

    // Should load only valid workspaces (1 and 3)
    expect(workspaces.length).toBe(2);
    expect(workspaces.map(w => w.id)).toEqual(['workspace-1-valid', 'workspace-3-valid']);
  });

  test('loadWorkspaces returns empty array when all workspaces have invalid paths', async () => {
    const workspace1Dirs = createWorkspaceDirectories('workspace-1-invalid');
    const workspace2Dirs = createWorkspaceDirectories('workspace-2-invalid');

    // Remove required directories to make both invalid
    rmSync(workspace1Dirs.OUTPUT_DIR, { recursive: true, force: true });
    rmSync(workspace2Dirs.SESSIONS_DIR, { recursive: true, force: true });

    const configPath = join(TEST_BASE_DIR, 'workspaces.json');
    const configData = {
      workspaces: [
        {
          id: 'workspace-1-invalid',
          ...workspace1Dirs,
        },
        {
          id: 'workspace-2-invalid',
          ...workspace2Dirs,
        },
      ],
    };

    writeFileSync(configPath, JSON.stringify(configData, null, 2));

    const loader = new DefaultConfigurationLoader(configPath);
    const workspaces = await loader.loadWorkspaces();

    // Should return empty array per Requirement 9.8
    expect(workspaces.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Requirement 2.7: Scanner logs warning and continues with remaining workspaces
// ---------------------------------------------------------------------------

describe('Requirement 2.7: Multi-workspace scanner handles non-existent paths', () => {
  test('scanChains continues scanning when one workspace path does not exist', async () => {
    const workspace1Dirs = createWorkspaceDirectories('workspace-scan-1');
    const workspace2Dirs = createWorkspaceDirectories('workspace-scan-2');

    // Create chains in workspace 1
    createChainFile(workspace1Dirs.SESSIONS_DIR, 'chain-ws1-alpha');
    createChainFile(workspace1Dirs.SESSIONS_DIR, 'chain-ws1-beta');

    // Create chains in workspace 2
    createChainFile(workspace2Dirs.SESSIONS_DIR, 'chain-ws2-gamma');

    // Invalidate cache and scan workspace 1 (should succeed)
    invalidateChainsCache();
    const chains1 = await scanChains(workspace1Dirs.SESSIONS_DIR, [], 'workspace-scan-1');
    expect(chains1.length).toBe(2);
    expect(chains1.map(c => c.chainId).sort()).toEqual(['chain-ws1-alpha', 'chain-ws1-beta']);
    expect(chains1.every(c => c.workspaceId === 'workspace-scan-1')).toBe(true);

    // Scan non-existent path (should return empty array due to try-catch in scanChains)
    invalidateChainsCache();
    const nonExistentPath = join(TEST_BASE_DIR, 'non-existent-workspace', '.kiro', 'sessions');
    const chainsNonExistent = await scanChains(nonExistentPath, [], 'workspace-non-existent');
    expect(chainsNonExistent.length).toBe(0);

    // Scan workspace 2 (should still succeed)
    invalidateChainsCache();
    const chains2 = await scanChains(workspace2Dirs.SESSIONS_DIR, [], 'workspace-scan-2');
    expect(chains2.length).toBe(1);
    expect(chains2[0].chainId).toBe('chain-ws2-gamma');
    expect(chains2[0].workspaceId).toBe('workspace-scan-2');
  });

  test('scanSessions continues scanning when one workspace path does not exist', async () => {
    const workspace1Dirs = createWorkspaceDirectories('workspace-sess-1');
    const workspace2Dirs = createWorkspaceDirectories('workspace-sess-2');

    // Create sessions in workspace 1
    createSessionFile(workspace1Dirs.SESSIONS_DIR, 'chain-sess-1', 'wh-sess-1-001');
    createSessionFile(workspace1Dirs.SESSIONS_DIR, 'chain-sess-1', 'wh-sess-1-002');

    // Create sessions in workspace 2
    createSessionFile(workspace2Dirs.SESSIONS_DIR, 'chain-sess-2', 'wh-sess-2-001');

    // Invalidate cache and scan workspace 1 (should succeed)
    invalidateSessionsCache();
    const sessions1 = await scanSessions(workspace1Dirs.SESSIONS_DIR, 'workspace-sess-1');
    expect(sessions1.length).toBe(2);
    expect(sessions1.every(s => s.workspaceId === 'workspace-sess-1')).toBe(true);

    // Scan non-existent path (should return empty array due to try-catch in scanSessions)
    invalidateSessionsCache();
    const nonExistentPath = join(TEST_BASE_DIR, 'non-existent-workspace', '.kiro', 'sessions');
    const sessionsNonExistent = await scanSessions(nonExistentPath, 'workspace-non-existent');
    expect(sessionsNonExistent.length).toBe(0);

    // Scan workspace 2 (should still succeed)
    invalidateSessionsCache();
    const sessions2 = await scanSessions(workspace2Dirs.SESSIONS_DIR, 'workspace-sess-2');
    expect(sessions2.length).toBe(1);
    expect(sessions2[0].workspaceId).toBe('workspace-sess-2');
  });

  test('scanJobs continues scanning when one workspace path does not exist', async () => {
    const workspace1Dirs = createWorkspaceDirectories('workspace-jobs-1');
    const workspace2Dirs = createWorkspaceDirectories('workspace-jobs-2');

    // Create jobs in workspace 1
    createJobFile(workspace1Dirs.OUTPUT_DIR, '2026-01-15-1000-test-job-1');
    createJobFile(workspace1Dirs.OUTPUT_DIR, '2026-01-15-1100-test-job-2');

    // Create jobs in workspace 2
    createJobFile(workspace2Dirs.OUTPUT_DIR, '2026-01-15-1200-test-job-3');

    // Scan workspace 1 (should succeed)
    const jobs1 = await scanJobs(workspace1Dirs.OUTPUT_DIR, 'workspace-jobs-1');
    expect(jobs1.length).toBe(2);
    expect(jobs1.every(j => j.workspaceId === 'workspace-jobs-1')).toBe(true);

    // Scan non-existent path (should throw error, which simulates scan failure)
    const nonExistentPath = join(TEST_BASE_DIR, 'non-existent-workspace', 'output');
    let scanFailed = false;
    try {
      await scanJobs(nonExistentPath, 'workspace-non-existent');
    } catch (error) {
      // Expected behavior: scanner fails when path doesn't exist
      // In a real multi-workspace scenario, the orchestrator would catch this
      // and continue with other workspaces
      scanFailed = true;
    }
    expect(scanFailed).toBe(true);

    // Scan workspace 2 (should still succeed after failed scan)
    const jobs2 = await scanJobs(workspace2Dirs.OUTPUT_DIR, 'workspace-jobs-2');
    expect(jobs2.length).toBe(1);
    expect(jobs2[0].workspaceId).toBe('workspace-jobs-2');
  });
});

// ---------------------------------------------------------------------------
// Requirement 2.8: Scanner logs error on scan failure and continues with remaining workspaces
// ---------------------------------------------------------------------------

describe('Requirement 2.8: Multi-workspace scanner handles scan failures', () => {
  test('scanChains handles malformed chain.json and continues scanning', async () => {
    const workspaceDirs = createWorkspaceDirectories('workspace-malformed');

    // Create a valid chain
    createChainFile(workspaceDirs.SESSIONS_DIR, 'chain-valid');

    // Create a malformed chain.json
    const malformedChainDir = join(workspaceDirs.SESSIONS_DIR, 'chain-malformed');
    mkdirSync(malformedChainDir, { recursive: true });
    writeFileSync(join(malformedChainDir, 'chain.json'), '{ invalid json }');

    // Create another valid chain
    createChainFile(workspaceDirs.SESSIONS_DIR, 'chain-valid-2');

    // Invalidate cache and scan should skip malformed and return valid chains
    invalidateChainsCache();
    const chains = await scanChains(workspaceDirs.SESSIONS_DIR, [], 'workspace-malformed');
    expect(chains.length).toBe(2);
    expect(chains.map(c => c.chainId).sort()).toEqual(['chain-valid', 'chain-valid-2']);
  });

  test('scanSessions handles malformed session state and continues scanning', async () => {
    const workspaceDirs = createWorkspaceDirectories('workspace-sess-malformed');

    // Create a valid session
    createSessionFile(workspaceDirs.SESSIONS_DIR, 'chain-sess', 'wh-sess-valid-001');

    // Create a malformed session state file
    const malformedStateDir = join(workspaceDirs.SESSIONS_DIR, '2026-01-15_chain-sess', 'State');
    mkdirSync(malformedStateDir, { recursive: true });
    writeFileSync(join(malformedStateDir, 'wh-sess-malformed.json'), '{ invalid json }');

    // Create another valid session
    createSessionFile(workspaceDirs.SESSIONS_DIR, 'chain-sess', 'wh-sess-valid-002');

    // Invalidate cache and scan should skip malformed and return valid sessions
    invalidateSessionsCache();
    const sessions = await scanSessions(workspaceDirs.SESSIONS_DIR, 'workspace-sess-malformed');
    expect(sessions.length).toBe(2);
    expect(sessions.map(s => s.workflowHash).sort()).toEqual(['wh-sess-valid-001', 'wh-sess-valid-002']);
  });
});

// ---------------------------------------------------------------------------
// Integration test: Scanner reads from workspace-specific paths
// ---------------------------------------------------------------------------

describe('Integration: Scanner reads from workspace-specific paths', () => {
  test('scanners read data from correct workspace-specific directories', async () => {
    // Create three workspaces with distinct data
    const ws1Dirs = createWorkspaceDirectories('workspace-alpha');
    const ws2Dirs = createWorkspaceDirectories('workspace-beta');
    const ws3Dirs = createWorkspaceDirectories('workspace-gamma');

    // Workspace Alpha: 2 chains, 2 sessions, 2 jobs
    createChainFile(ws1Dirs.SESSIONS_DIR, 'chain-alpha-1');
    createChainFile(ws1Dirs.SESSIONS_DIR, 'chain-alpha-2');
    createSessionFile(ws1Dirs.SESSIONS_DIR, 'chain-alpha-1', 'wh-alpha-001');
    createSessionFile(ws1Dirs.SESSIONS_DIR, 'chain-alpha-2', 'wh-alpha-002');
    createJobFile(ws1Dirs.OUTPUT_DIR, '2026-01-15-1000-alpha-job-1');
    createJobFile(ws1Dirs.OUTPUT_DIR, '2026-01-15-1100-alpha-job-2');

    // Workspace Beta: 1 chain, 2 sessions, 1 job
    createChainFile(ws2Dirs.SESSIONS_DIR, 'chain-beta-1');
    createSessionFile(ws2Dirs.SESSIONS_DIR, 'chain-beta-1', 'wh-beta-001');
    createSessionFile(ws2Dirs.SESSIONS_DIR, 'chain-beta-1', 'wh-beta-002');
    createJobFile(ws2Dirs.OUTPUT_DIR, '2026-01-15-1200-beta-job-1');

    // Workspace Gamma: 3 chains, 1 session, 3 jobs
    createChainFile(ws3Dirs.SESSIONS_DIR, 'chain-gamma-1');
    createChainFile(ws3Dirs.SESSIONS_DIR, 'chain-gamma-2');
    createChainFile(ws3Dirs.SESSIONS_DIR, 'chain-gamma-3');
    createSessionFile(ws3Dirs.SESSIONS_DIR, 'chain-gamma-1', 'wh-gamma-001');
    createJobFile(ws3Dirs.OUTPUT_DIR, '2026-01-15-1300-gamma-job-1');
    createJobFile(ws3Dirs.OUTPUT_DIR, '2026-01-15-1400-gamma-job-2');
    createJobFile(ws3Dirs.OUTPUT_DIR, '2026-01-15-1500-gamma-job-3');

    // Scan each workspace independently with cache invalidation
    invalidateChainsCache();
    const chainsAlpha = await scanChains(ws1Dirs.SESSIONS_DIR, [], 'workspace-alpha');
    invalidateSessionsCache();
    const sessionAlpha = await scanSessions(ws1Dirs.SESSIONS_DIR, 'workspace-alpha');
    const jobsAlpha = await scanJobs(ws1Dirs.OUTPUT_DIR, 'workspace-alpha');

    invalidateChainsCache();
    const chainsBeta = await scanChains(ws2Dirs.SESSIONS_DIR, [], 'workspace-beta');
    invalidateSessionsCache();
    const sessionsBeta = await scanSessions(ws2Dirs.SESSIONS_DIR, 'workspace-beta');
    const jobsBeta = await scanJobs(ws2Dirs.OUTPUT_DIR, 'workspace-beta');

    invalidateChainsCache();
    const chainsGamma = await scanChains(ws3Dirs.SESSIONS_DIR, [], 'workspace-gamma');
    invalidateSessionsCache();
    const sessionsGamma = await scanSessions(ws3Dirs.SESSIONS_DIR, 'workspace-gamma');
    const jobsGamma = await scanJobs(ws3Dirs.OUTPUT_DIR, 'workspace-gamma');

    // Verify correct counts for each workspace
    expect(chainsAlpha.length).toBe(2);
    expect(sessionAlpha.length).toBe(2);
    expect(jobsAlpha.length).toBe(2);

    expect(chainsBeta.length).toBe(1);
    expect(sessionsBeta.length).toBe(2);
    expect(jobsBeta.length).toBe(1);

    expect(chainsGamma.length).toBe(3);
    expect(sessionsGamma.length).toBe(1);
    expect(jobsGamma.length).toBe(3);

    // Verify workspaceId is correctly set
    expect(chainsAlpha.every(c => c.workspaceId === 'workspace-alpha')).toBe(true);
    expect(sessionAlpha.every(s => s.workspaceId === 'workspace-alpha')).toBe(true);
    expect(jobsAlpha.every(j => j.workspaceId === 'workspace-alpha')).toBe(true);

    expect(chainsBeta.every(c => c.workspaceId === 'workspace-beta')).toBe(true);
    expect(sessionsBeta.every(s => s.workspaceId === 'workspace-beta')).toBe(true);
    expect(jobsBeta.every(j => j.workspaceId === 'workspace-beta')).toBe(true);

    expect(chainsGamma.every(c => c.workspaceId === 'workspace-gamma')).toBe(true);
    expect(sessionsGamma.every(s => s.workspaceId === 'workspace-gamma')).toBe(true);
    expect(jobsGamma.every(j => j.workspaceId === 'workspace-gamma')).toBe(true);

    // Verify data isolation: chains from alpha should not contain beta or gamma data
    expect(chainsAlpha.every(c => c.chainId.includes('alpha'))).toBe(true);
    expect(chainsBeta.every(c => c.chainId.includes('beta'))).toBe(true);
    expect(chainsGamma.every(c => c.chainId.includes('gamma'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration test: Mixed valid/invalid workspaces
// ---------------------------------------------------------------------------

describe('Integration: Mixed valid and invalid workspaces', () => {
  test('configuration loader and scanners handle mixed valid/invalid workspaces correctly', async () => {
    // Create multiple workspaces with different validity states
    const ws1Dirs = createWorkspaceDirectories('workspace-valid-1');
    const ws2Dirs = createWorkspaceDirectories('workspace-invalid-missing-output');
    const ws3Dirs = createWorkspaceDirectories('workspace-valid-2');
    const ws4Dirs = createWorkspaceDirectories('workspace-invalid-missing-sessions');

    // Add data to valid workspaces
    createChainFile(ws1Dirs.SESSIONS_DIR, 'chain-valid-1');
    createSessionFile(ws1Dirs.SESSIONS_DIR, 'chain-valid-1', 'wh-valid-1-001');
    createJobFile(ws1Dirs.OUTPUT_DIR, '2026-01-15-1000-valid-1-job');

    createChainFile(ws3Dirs.SESSIONS_DIR, 'chain-valid-2');
    createSessionFile(ws3Dirs.SESSIONS_DIR, 'chain-valid-2', 'wh-valid-2-001');
    createJobFile(ws3Dirs.OUTPUT_DIR, '2026-01-15-1100-valid-2-job');

    // Make workspace-invalid-missing-output invalid by removing OUTPUT_DIR
    rmSync(ws2Dirs.OUTPUT_DIR, { recursive: true, force: true });

    // Make workspace-invalid-missing-sessions invalid by removing SESSIONS_DIR
    rmSync(ws4Dirs.SESSIONS_DIR, { recursive: true, force: true });

    // Create configuration file
    const configPath = join(TEST_BASE_DIR, 'workspaces-mixed.json');
    const configData = {
      workspaces: [
        { id: 'workspace-valid-1', ...ws1Dirs },
        { id: 'workspace-invalid-missing-output', ...ws2Dirs },
        { id: 'workspace-valid-2', ...ws3Dirs },
        { id: 'workspace-invalid-missing-sessions', ...ws4Dirs },
      ],
    };

    writeFileSync(configPath, JSON.stringify(configData, null, 2));

    // Load workspaces - should only load valid ones
    const loader = new DefaultConfigurationLoader(configPath);
    const workspaces = await loader.loadWorkspaces();

    expect(workspaces.length).toBe(2);
    expect(workspaces.map(w => w.id).sort()).toEqual([
      'workspace-valid-1',
      'workspace-valid-2',
    ]);

    // Scan each valid workspace with cache invalidation
    const results = await Promise.all(
      workspaces.map(async ws => {
        invalidateChainsCache();
        invalidateSessionsCache();
        return {
          workspaceId: ws.id,
          chains: await scanChains(ws.SESSIONS_DIR, [], ws.id),
          sessions: await scanSessions(ws.SESSIONS_DIR, ws.id),
          jobs: await scanJobs(ws.OUTPUT_DIR, ws.id),
        };
      })
    );

    // Verify results for valid workspaces
    expect(results.length).toBe(2);

    const ws1Results = results.find(r => r.workspaceId === 'workspace-valid-1');
    expect(ws1Results).toBeDefined();
    expect(ws1Results!.chains.length).toBe(1);
    expect(ws1Results!.sessions.length).toBe(1);
    expect(ws1Results!.jobs.length).toBe(1);
    expect(ws1Results!.chains[0].chainId).toBe('chain-valid-1');

    const ws3Results = results.find(r => r.workspaceId === 'workspace-valid-2');
    expect(ws3Results).toBeDefined();
    expect(ws3Results!.chains.length).toBe(1);
    expect(ws3Results!.sessions.length).toBe(1);
    expect(ws3Results!.jobs.length).toBe(1);
    expect(ws3Results!.chains[0].chainId).toBe('chain-valid-2');
  });
});
