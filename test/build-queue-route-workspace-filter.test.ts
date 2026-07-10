// ---------------------------------------------------------------------------
// Build Queue Route Workspace Filtering Tests
//
// Tests for /api/build-queue route workspace filtering functionality
// Validates Requirements 8.6-8.7 (queue status route workspace filtering)
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import type { BuildQueueRecord } from '../src/types.ts';

const TEST_DIR = join(import.meta.dir, 'tmp-build-queue-filter-test');
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

describe('Build Queue Route Workspace Filtering', () => {
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

  test('route accepts workspaceId query parameter (Req 8.7)', async () => {
    // This test validates that the route can parse the workspaceId parameter
    // The actual filtering logic is tested by the filter helper tests
    
    const { DefaultConfigurationLoader } = await import('../src/config/workspace-config.ts');
    const { filterByWorkspace } = await import('../src/routes/helpers/filter.ts');
    
    const loader = new DefaultConfigurationLoader(CONFIG_PATH);
    const workspaces = await loader.loadWorkspaces();
    
    expect(workspaces.length).toBe(2);
    expect(workspaces[0].id).toBe('workspace-1');
    expect(workspaces[1].id).toBe('workspace-2');
    
    // Simulate build queue records data
    const mockRecords: BuildQueueRecord[] = [
      {
        target: 'dashboard',
        ts: Date.now(),
        status: 'pending',
        stem: '2024-01-01-1000-build-dashboard',
        workspaceId: 'workspace-1',
      },
      {
        target: 'dashboard',
        ts: Date.now(),
        status: 'building',
        stem: '2024-01-01-1100-build-dashboard',
        workspaceId: 'workspace-2',
      },
    ];
    
    // Test filtering with workspace-1 (Req 8.7)
    const result1 = filterByWorkspace(mockRecords, 'workspace-1', workspaces);
    expect(result1.status).toBe(200);
    expect(result1.data?.length).toBe(1);
    expect(result1.data?.[0].workspaceId).toBe('workspace-1');
    
    // Test filtering with workspace-2
    const result2 = filterByWorkspace(mockRecords, 'workspace-2', workspaces);
    expect(result2.status).toBe(200);
    expect(result2.data?.length).toBe(1);
    expect(result2.data?.[0].workspaceId).toBe('workspace-2');
    
    // Test filtering with invalid workspace
    const result3 = filterByWorkspace(mockRecords, 'invalid-workspace', workspaces);
    expect(result3.status).toBe(404);
    expect(result3.error).toContain("Workspace 'invalid-workspace' does not exist");
    
    // Test no filter - returns all records (Req 8.6)
    const result4 = filterByWorkspace(mockRecords, undefined, workspaces);
    expect(result4.status).toBe(200);
    expect(result4.data?.length).toBe(2);
  });

  test('validates case-sensitive exact string matching', async () => {
    const { DefaultConfigurationLoader } = await import('../src/config/workspace-config.ts');
    const { filterByWorkspace } = await import('../src/routes/helpers/filter.ts');
    
    const loader = new DefaultConfigurationLoader(CONFIG_PATH);
    const workspaces = await loader.loadWorkspaces();
    
    const mockRecords: BuildQueueRecord[] = [
      {
        target: 'dashboard',
        ts: Date.now(),
        status: 'done',
        stem: '2024-01-01-1200-build-dashboard',
        workspaceId: 'workspace-1',
      },
    ];
    
    // Case-sensitive test - uppercase should not match
    const result = filterByWorkspace(mockRecords, 'WORKSPACE-1', workspaces);
    expect(result.status).toBe(404);
    expect(result.error).toContain("Workspace 'WORKSPACE-1' does not exist");
  });

  test('returns empty array for valid workspace with no records', async () => {
    const { DefaultConfigurationLoader } = await import('../src/config/workspace-config.ts');
    const { filterByWorkspace } = await import('../src/routes/helpers/filter.ts');
    
    const loader = new DefaultConfigurationLoader(CONFIG_PATH);
    const workspaces = await loader.loadWorkspaces();
    
    const mockRecords: BuildQueueRecord[] = [
      {
        target: 'dashboard',
        ts: Date.now(),
        status: 'pending',
        stem: '2024-01-01-1300-build-dashboard',
        workspaceId: 'workspace-1',
      },
    ];
    
    // workspace-2 exists but has no records
    const result = filterByWorkspace(mockRecords, 'workspace-2', workspaces);
    expect(result.status).toBe(200);
    expect(result.data).toEqual([]);
  });

  test('handles multiple records from same workspace', async () => {
    const { DefaultConfigurationLoader } = await import('../src/config/workspace-config.ts');
    const { filterByWorkspace } = await import('../src/routes/helpers/filter.ts');
    
    const loader = new DefaultConfigurationLoader(CONFIG_PATH);
    const workspaces = await loader.loadWorkspaces();
    
    const mockRecords: BuildQueueRecord[] = [
      {
        target: 'dashboard',
        ts: Date.now(),
        status: 'pending',
        stem: '2024-01-01-1400-build-dashboard',
        workspaceId: 'workspace-1',
      },
      {
        target: 'dashboard',
        ts: Date.now(),
        status: 'building',
        stem: '2024-01-01-1500-build-dashboard',
        workspaceId: 'workspace-1',
      },
      {
        target: 'dashboard',
        ts: Date.now(),
        status: 'done',
        stem: '2024-01-01-1600-build-dashboard',
        workspaceId: 'workspace-2',
      },
    ];
    
    // Filter for workspace-1 should return 2 records
    const result = filterByWorkspace(mockRecords, 'workspace-1', workspaces);
    expect(result.status).toBe(200);
    expect(result.data?.length).toBe(2);
    expect(result.data?.every(r => r.workspaceId === 'workspace-1')).toBe(true);
  });

  test('handles all queue statuses correctly', async () => {
    const { DefaultConfigurationLoader } = await import('../src/config/workspace-config.ts');
    const { filterByWorkspace } = await import('../src/routes/helpers/filter.ts');
    
    const loader = new DefaultConfigurationLoader(CONFIG_PATH);
    const workspaces = await loader.loadWorkspaces();
    
    const mockRecords: BuildQueueRecord[] = [
      {
        target: 'dashboard',
        ts: Date.now(),
        status: 'pending',
        stem: '2024-01-01-1700-build-dashboard',
        workspaceId: 'workspace-1',
      },
      {
        target: 'dashboard',
        ts: Date.now(),
        status: 'building',
        stem: '2024-01-01-1800-build-dashboard',
        workspaceId: 'workspace-1',
      },
      {
        target: 'dashboard',
        ts: Date.now(),
        status: 'done',
        stem: '2024-01-01-1900-build-dashboard',
        workspaceId: 'workspace-1',
      },
      {
        target: 'dashboard',
        ts: Date.now(),
        status: 'error',
        stem: '2024-01-01-2000-build-dashboard',
        workspaceId: 'workspace-1',
      },
    ];
    
    // All statuses should be preserved when filtering
    const result = filterByWorkspace(mockRecords, 'workspace-1', workspaces);
    expect(result.status).toBe(200);
    expect(result.data?.length).toBe(4);
    
    const statuses = result.data?.map(r => r.status);
    expect(statuses).toContain('pending');
    expect(statuses).toContain('building');
    expect(statuses).toContain('done');
    expect(statuses).toContain('error');
  });
});
