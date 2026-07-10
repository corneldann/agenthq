// ---------------------------------------------------------------------------
// Workspace Filtering Helper Tests
//
// Tests for the common workspace filtering utilities used across API routes.
// Validates Requirements 5.4, 5.9, 5.14, 5.19 (404 responses)
// Validates Requirements 5.4.1, 5.9.1, 5.14.1, 5.19.1 (200 with empty array)
// Validates case-sensitive exact string matching
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import {
  validateWorkspaceId,
  filterByWorkspace,
  createFilterResponse,
  type WorkspaceIdentified,
} from '../src/routes/helpers/filter.ts';
import type { WorkspaceConfig } from '../src/config/workspace-config.ts';

// Test fixtures
const mockWorkspaces: WorkspaceConfig[] = [
  {
    id: 'workspace-alpha',
    OUTPUT_DIR: '/tmp/alpha/output',
    SESSIONS_DIR: '/tmp/alpha/sessions',
    WORKSPACE_ROOT: '/tmp/alpha',
  },
  {
    id: 'workspace-beta',
    OUTPUT_DIR: '/tmp/beta/output',
    SESSIONS_DIR: '/tmp/beta/sessions',
    WORKSPACE_ROOT: '/tmp/beta',
  },
];

interface TestEntity extends WorkspaceIdentified {
  name: string;
}

const mockData: TestEntity[] = [
  { workspaceId: 'workspace-alpha', name: 'item-1' },
  { workspaceId: 'workspace-alpha', name: 'item-2' },
  { workspaceId: 'workspace-beta', name: 'item-3' },
];

describe('validateWorkspaceId', () => {
  test('returns true for valid workspace ID', () => {
    expect(validateWorkspaceId('workspace-alpha', mockWorkspaces)).toBe(true);
    expect(validateWorkspaceId('workspace-beta', mockWorkspaces)).toBe(true);
  });

  test('returns false for invalid workspace ID', () => {
    expect(validateWorkspaceId('workspace-gamma', mockWorkspaces)).toBe(false);
    expect(validateWorkspaceId('nonexistent', mockWorkspaces)).toBe(false);
  });

  test('performs case-sensitive validation', () => {
    expect(validateWorkspaceId('Workspace-Alpha', mockWorkspaces)).toBe(false);
    expect(validateWorkspaceId('WORKSPACE-ALPHA', mockWorkspaces)).toBe(false);
  });

  test('returns false for empty workspace array', () => {
    expect(validateWorkspaceId('workspace-alpha', [])).toBe(false);
  });
});

describe('filterByWorkspace - no filter provided', () => {
  test('returns all data with status 200 when workspaceId is null', () => {
    const result = filterByWorkspace(mockData, null, mockWorkspaces);
    
    expect(result.status).toBe(200);
    expect(result.data).toEqual(mockData);
    expect(result.error).toBeUndefined();
  });

  test('returns all data with status 200 when workspaceId is undefined', () => {
    const result = filterByWorkspace(mockData, undefined, mockWorkspaces);
    
    expect(result.status).toBe(200);
    expect(result.data).toEqual(mockData);
    expect(result.error).toBeUndefined();
  });

  test('returns all data with status 200 when workspaceId is empty string', () => {
    const result = filterByWorkspace(mockData, '', mockWorkspaces);
    
    expect(result.status).toBe(200);
    expect(result.data).toEqual(mockData);
    expect(result.error).toBeUndefined();
  });
});

describe('filterByWorkspace - invalid workspace ID (Req 5.4, 5.9, 5.14, 5.19)', () => {
  test('returns 404 with error message for nonexistent workspace', () => {
    const result = filterByWorkspace(mockData, 'workspace-gamma', mockWorkspaces);
    
    expect(result.status).toBe(404);
    expect(result.error).toBe("Workspace 'workspace-gamma' does not exist");
    expect(result.data).toBeUndefined();
  });

  test('returns 404 for case-mismatch workspace ID', () => {
    const result = filterByWorkspace(mockData, 'Workspace-Alpha', mockWorkspaces);
    
    expect(result.status).toBe(404);
    expect(result.error).toBe("Workspace 'Workspace-Alpha' does not exist");
    expect(result.data).toBeUndefined();
  });

  test('returns 404 for completely invalid workspace ID', () => {
    const result = filterByWorkspace(mockData, 'invalid-workspace-id', mockWorkspaces);
    
    expect(result.status).toBe(404);
    expect(result.error).toBe("Workspace 'invalid-workspace-id' does not exist");
    expect(result.data).toBeUndefined();
  });
});

describe('filterByWorkspace - valid workspace with data (Req 5.2, 5.7, 5.12, 5.17)', () => {
  test('returns filtered data for workspace-alpha', () => {
    const result = filterByWorkspace(mockData, 'workspace-alpha', mockWorkspaces);
    
    expect(result.status).toBe(200);
    expect(result.data).toHaveLength(2);
    expect(result.data![0].name).toBe('item-1');
    expect(result.data![1].name).toBe('item-2');
    expect(result.error).toBeUndefined();
  });

  test('returns filtered data for workspace-beta', () => {
    const result = filterByWorkspace(mockData, 'workspace-beta', mockWorkspaces);
    
    expect(result.status).toBe(200);
    expect(result.data).toHaveLength(1);
    expect(result.data![0].name).toBe('item-3');
    expect(result.error).toBeUndefined();
  });

  test('performs case-sensitive exact string matching', () => {
    const mixedCaseData: TestEntity[] = [
      { workspaceId: 'workspace-alpha', name: 'lowercase' },
      { workspaceId: 'Workspace-Alpha', name: 'mixed-case' },
      { workspaceId: 'WORKSPACE-ALPHA', name: 'uppercase' },
    ];
    
    const result = filterByWorkspace(mixedCaseData, 'workspace-alpha', mockWorkspaces);
    
    expect(result.status).toBe(200);
    expect(result.data).toHaveLength(1);
    expect(result.data![0].name).toBe('lowercase');
  });
});

describe('filterByWorkspace - valid workspace with no data (Req 5.4.1, 5.9.1, 5.14.1, 5.19.1)', () => {
  test('returns empty array with status 200 for valid workspace with no matching data', () => {
    const emptyData: TestEntity[] = [];
    const result = filterByWorkspace(emptyData, 'workspace-alpha', mockWorkspaces);
    
    expect(result.status).toBe(200);
    expect(result.data).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  test('returns empty array with status 200 when workspace has no items in dataset', () => {
    const alphaOnlyData: TestEntity[] = [
      { workspaceId: 'workspace-alpha', name: 'item-1' },
    ];
    
    // Filter for workspace-beta which has no items
    const result = filterByWorkspace(alphaOnlyData, 'workspace-beta', mockWorkspaces);
    
    expect(result.status).toBe(200);
    expect(result.data).toEqual([]);
    expect(result.error).toBeUndefined();
  });
});

describe('createFilterResponse', () => {
  test('creates 404 Response with error message', async () => {
    const filterResult = {
      status: 404,
      error: "Workspace 'invalid' does not exist",
    };
    
    const response = createFilterResponse(filterResult);
    
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json');
    
    const body = await response.json();
    expect(body).toEqual({ error: "Workspace 'invalid' does not exist" });
  });

  test('creates 200 Response with data and connection close header', async () => {
    const filterResult = {
      status: 200,
      data: mockData,
    };
    
    const response = createFilterResponse(filterResult);
    
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('connection')).toBe('close');
    
    const body = await response.json();
    expect(body).toEqual(mockData);
  });

  test('creates 200 Response with empty array', async () => {
    const filterResult = {
      status: 200,
      data: [],
    };
    
    const response = createFilterResponse(filterResult);
    
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual([]);
  });
});

describe('Edge cases', () => {
  test('handles data with no items', () => {
    const result = filterByWorkspace([], 'workspace-alpha', mockWorkspaces);
    
    expect(result.status).toBe(200);
    expect(result.data).toEqual([]);
  });

  test('handles workspace config with no workspaces', () => {
    const result = filterByWorkspace(mockData, 'workspace-alpha', []);
    
    expect(result.status).toBe(404);
    expect(result.error).toBe("Workspace 'workspace-alpha' does not exist");
  });

  test('preserves all fields in filtered entities', () => {
    const complexData: (TestEntity & { extra: number })[] = [
      { workspaceId: 'workspace-alpha', name: 'item-1', extra: 42 },
      { workspaceId: 'workspace-beta', name: 'item-2', extra: 99 },
    ];
    
    const result = filterByWorkspace(complexData, 'workspace-alpha', mockWorkspaces);
    
    expect(result.status).toBe(200);
    expect(result.data).toHaveLength(1);
    expect(result.data![0]).toEqual({
      workspaceId: 'workspace-alpha',
      name: 'item-1',
      extra: 42,
    });
  });
});
