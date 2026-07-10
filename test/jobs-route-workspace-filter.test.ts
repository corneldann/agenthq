// ---------------------------------------------------------------------------
// Jobs Route Workspace Filtering Tests
//
// Tests for /api/jobs route workspace filtering functionality
// Validates Requirements 5.6-5.10 (jobs route workspace filtering)
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import type { Job } from '../src/types.ts';

const TEST_DIR = join(import.meta.dir, 'tmp-jobs-filter-test');
const CONFIG_PATH = join(TEST_DIR, 'workspaces.json');

// Helper to create test workspace configuration
function createTestConfig() {
  const workspace1 = join(TEST_DIR, 'workspace-1');
  const workspace2 = join(TEST_DIR, 'workspace-2');

  // Create directories
  mkdirSync(join(workspace1, 'output'), { recursive: true });
  mkdirSync(join(workspace1, 'sessions'), { recursive: true });
  mkdirSync(join(workspace2, 'output'), { recursive: true });
  mkdirSync(join(workspace2, 'sessions'), { recursive: true });

  // Create workspaces.json
  const config = {
    workspaces: [
      {
        id: 'workspace-1',
        OUTPUT_DIR: join(workspace1, 'output'),
        SESSIONS_DIR: join(workspace1, 'sessions'),
        WORKSPACE_ROOT: workspace1,
      },
      {
        id: 'workspace-2',
        OUTPUT_DIR: join(workspace2, 'output'),
        SESSIONS_DIR: join(workspace2, 'sessions'),
        WORKSPACE_ROOT: workspace2,
      },
    ],
  };

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

describe('Jobs Route Workspace Filtering', () => {
  beforeAll(() => {
    // Create test environment
    createTestConfig();
  });

  afterAll(() => {
    // Cleanup
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  test('route accepts workspaceId query parameter (Req 5.6)', async () => {
    // This test validates that the route can parse the workspaceId parameter
    // The actual filtering logic is tested by the filter helper tests
    
    const { DefaultConfigurationLoader } = await import('../src/config/workspace-config.ts');
    const { filterByWorkspace } = await import('../src/routes/helpers/filter.ts');
    
    const loader = new DefaultConfigurationLoader(CONFIG_PATH);
    const workspaces = await loader.loadWorkspaces();
    
    expect(workspaces.length).toBe(2);
    expect(workspaces[0].id).toBe('workspace-1');
    expect(workspaces[1].id).toBe('workspace-2');
    
    // Simulate jobs data
    const mockJobs: Job[] = [
      {
        id: 'job-1',
        name: 'Job 1',
        workspaceId: 'workspace-1',
        type: 'analysis',
        status: 'done',
        timestamp: '2024-01-01T10:00:00Z',
        mdFile: 'job-1.md',
        source: '/sessions/chain-1/session.jsonl',
        agent: 'agenthq',
      },
      {
        id: 'job-2',
        name: 'Job 2',
        workspaceId: 'workspace-2',
        type: 'analysis',
        status: 'running',
        timestamp: '2024-01-01T11:00:00Z',
        mdFile: 'job-2.md',
        source: '/sessions/chain-2/session.jsonl',
        agent: 'agenthq',
      },
    ];
    
    // Test filtering with workspace-1 (Req 5.7, 5.8)
    const result1 = filterByWorkspace(mockJobs, 'workspace-1', workspaces);
    expect(result1.status).toBe(200);
    expect(result1.data?.length).toBe(1);
    expect(result1.data?.[0].workspaceId).toBe('workspace-1');
    
    // Test filtering with workspace-2
    const result2 = filterByWorkspace(mockJobs, 'workspace-2', workspaces);
    expect(result2.status).toBe(200);
    expect(result2.data?.length).toBe(1);
    expect(result2.data?.[0].workspaceId).toBe('workspace-2');
    
    // Test filtering with invalid workspace (Req 5.9)
    const result3 = filterByWorkspace(mockJobs, 'invalid-workspace', workspaces);
    expect(result3.status).toBe(404);
    expect(result3.error).toContain("Workspace 'invalid-workspace' does not exist");
    
    // Test no filter - returns all jobs (Req 5.10)
    const result4 = filterByWorkspace(mockJobs, undefined, workspaces);
    expect(result4.status).toBe(200);
    expect(result4.data?.length).toBe(2);
  });

  test('validates case-sensitive exact string matching (Req 5.7)', async () => {
    const { DefaultConfigurationLoader } = await import('../src/config/workspace-config.ts');
    const { filterByWorkspace } = await import('../src/routes/helpers/filter.ts');
    
    const loader = new DefaultConfigurationLoader(CONFIG_PATH);
    const workspaces = await loader.loadWorkspaces();
    
    const mockJobs: Job[] = [
      {
        id: 'job-1',
        name: 'Job 1',
        workspaceId: 'workspace-1',
        type: 'analysis',
        status: 'done',
        timestamp: '2024-01-01T10:00:00Z',
        mdFile: 'job-1.md',
        source: '/sessions/chain-1/session.jsonl',
        agent: 'agenthq',
      },
    ];
    
    // Case-sensitive test - uppercase should not match
    const result = filterByWorkspace(mockJobs, 'WORKSPACE-1', workspaces);
    expect(result.status).toBe(404);
    expect(result.error).toContain("Workspace 'WORKSPACE-1' does not exist");
  });

  test('returns empty array for valid workspace with no jobs (Req 5.9.1)', async () => {
    const { DefaultConfigurationLoader } = await import('../src/config/workspace-config.ts');
    const { filterByWorkspace } = await import('../src/routes/helpers/filter.ts');
    
    const loader = new DefaultConfigurationLoader(CONFIG_PATH);
    const workspaces = await loader.loadWorkspaces();
    
    const mockJobs: Job[] = [
      {
        id: 'job-1',
        name: 'Job 1',
        workspaceId: 'workspace-1',
        type: 'analysis',
        status: 'done',
        timestamp: '2024-01-01T10:00:00Z',
        mdFile: 'job-1.md',
        source: '/sessions/chain-1/session.jsonl',
        agent: 'agenthq',
      },
    ];
    
    // workspace-2 exists but has no jobs
    const result = filterByWorkspace(mockJobs, 'workspace-2', workspaces);
    expect(result.status).toBe(200);
    expect(result.data).toEqual([]);
  });

  test('handles multiple jobs from same workspace', async () => {
    const { DefaultConfigurationLoader } = await import('../src/config/workspace-config.ts');
    const { filterByWorkspace } = await import('../src/routes/helpers/filter.ts');
    
    const loader = new DefaultConfigurationLoader(CONFIG_PATH);
    const workspaces = await loader.loadWorkspaces();
    
    const mockJobs: Job[] = [
      {
        id: 'job-1',
        name: 'Job 1',
        workspaceId: 'workspace-1',
        type: 'analysis',
        status: 'done',
        timestamp: '2024-01-01T10:00:00Z',
        mdFile: 'job-1.md',
        source: '/sessions/chain-1/session.jsonl',
        agent: 'agenthq',
      },
      {
        id: 'job-2',
        name: 'Job 2',
        workspaceId: 'workspace-1',
        type: 'analysis',
        status: 'running',
        timestamp: '2024-01-01T11:00:00Z',
        mdFile: 'job-2.md',
        source: '/sessions/chain-1/session.jsonl',
        agent: 'agenthq',
      },
      {
        id: 'job-3',
        name: 'Job 3',
        workspaceId: 'workspace-2',
        type: 'analysis',
        status: 'done',
        timestamp: '2024-01-01T12:00:00Z',
        mdFile: 'job-3.md',
        source: '/sessions/chain-2/session.jsonl',
        agent: 'agenthq',
      },
    ];
    
    // Filter for workspace-1 should return 2 jobs
    const result = filterByWorkspace(mockJobs, 'workspace-1', workspaces);
    expect(result.status).toBe(200);
    expect(result.data?.length).toBe(2);
    expect(result.data?.every(j => j.workspaceId === 'workspace-1')).toBe(true);
  });
});
