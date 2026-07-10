// ---------------------------------------------------------------------------
// Chains Route Workspace Filtering Tests
//
// Tests for /api/chains route workspace filtering functionality
// Validates Requirements 5.1-5.5 (chains route workspace filtering)
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import type { Chain } from '../src/types.ts';

const TEST_DIR = join(import.meta.dir, 'tmp-chains-filter-test');
const CONFIG_PATH = join(TEST_DIR, 'workspaces.json');
const PORT = 9876; // Use a different port for testing

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

describe('Chains Route Workspace Filtering', () => {
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

  test('route accepts workspaceId query parameter (Req 5.1)', async () => {
    // This test validates that the route can parse the workspaceId parameter
    // The actual filtering logic is tested by the filter helper tests
    
    // We're validating the implementation structure rather than making actual HTTP calls
    // since we don't have a test server running
    const { DefaultConfigurationLoader } = await import('../src/config/workspace-config.ts');
    const { filterByWorkspace } = await import('../src/routes/helpers/filter.ts');
    
    const loader = new DefaultConfigurationLoader(CONFIG_PATH);
    const workspaces = await loader.loadWorkspaces();
    
    expect(workspaces.length).toBe(2);
    expect(workspaces[0].id).toBe('workspace-1');
    expect(workspaces[1].id).toBe('workspace-2');
    
    // Simulate chains data
    const mockChains: Chain[] = [
      {
        chainId: 'chain-1',
        displayName: 'Chain 1',
        workspaceId: 'workspace-1',
        totalMessages: 5,
        nextIndex: 2,
        sessions: [],
        createdAt: '2024-01-01',
        lastActiveAt: '2024-01-01',
        workflowCount: 1,
      },
      {
        chainId: 'chain-2',
        displayName: 'Chain 2',
        workspaceId: 'workspace-2',
        totalMessages: 3,
        nextIndex: 1,
        sessions: [],
        createdAt: '2024-01-01',
        lastActiveAt: '2024-01-01',
        workflowCount: 1,
      },
    ];
    
    // Test filtering with workspace-1
    const result1 = filterByWorkspace(mockChains, 'workspace-1', workspaces);
    expect(result1.status).toBe(200);
    expect(result1.data?.length).toBe(1);
    expect(result1.data?.[0].workspaceId).toBe('workspace-1');
    
    // Test filtering with workspace-2
    const result2 = filterByWorkspace(mockChains, 'workspace-2', workspaces);
    expect(result2.status).toBe(200);
    expect(result2.data?.length).toBe(1);
    expect(result2.data?.[0].workspaceId).toBe('workspace-2');
    
    // Test filtering with invalid workspace (Req 5.4)
    const result3 = filterByWorkspace(mockChains, 'invalid-workspace', workspaces);
    expect(result3.status).toBe(404);
    expect(result3.error).toContain("Workspace 'invalid-workspace' does not exist");
    
    // Test no filter (Req 5.5)
    const result4 = filterByWorkspace(mockChains, undefined, workspaces);
    expect(result4.status).toBe(200);
    expect(result4.data?.length).toBe(2);
  });

  test('validates case-sensitive exact string matching (Req 5.2)', async () => {
    const { DefaultConfigurationLoader } = await import('../src/config/workspace-config.ts');
    const { filterByWorkspace } = await import('../src/routes/helpers/filter.ts');
    
    const loader = new DefaultConfigurationLoader(CONFIG_PATH);
    const workspaces = await loader.loadWorkspaces();
    
    const mockChains: Chain[] = [
      {
        chainId: 'chain-1',
        displayName: 'Chain 1',
        workspaceId: 'workspace-1',
        totalMessages: 5,
        nextIndex: 2,
        sessions: [],
        createdAt: '2024-01-01',
        lastActiveAt: '2024-01-01',
        workflowCount: 1,
      },
    ];
    
    // Case-sensitive test - uppercase should not match
    const result = filterByWorkspace(mockChains, 'WORKSPACE-1', workspaces);
    expect(result.status).toBe(404);
    expect(result.error).toContain("Workspace 'WORKSPACE-1' does not exist");
  });

  test('returns empty array for valid workspace with no chains (Req 5.4.1)', async () => {
    const { DefaultConfigurationLoader } = await import('../src/config/workspace-config.ts');
    const { filterByWorkspace } = await import('../src/routes/helpers/filter.ts');
    
    const loader = new DefaultConfigurationLoader(CONFIG_PATH);
    const workspaces = await loader.loadWorkspaces();
    
    const mockChains: Chain[] = [
      {
        chainId: 'chain-1',
        displayName: 'Chain 1',
        workspaceId: 'workspace-1',
        totalMessages: 5,
        nextIndex: 2,
        sessions: [],
        createdAt: '2024-01-01',
        lastActiveAt: '2024-01-01',
        workflowCount: 1,
      },
    ];
    
    // workspace-2 exists but has no chains
    const result = filterByWorkspace(mockChains, 'workspace-2', workspaces);
    expect(result.status).toBe(200);
    expect(result.data).toEqual([]);
  });
});
