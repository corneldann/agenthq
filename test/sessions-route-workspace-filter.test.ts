// ---------------------------------------------------------------------------
// Sessions Route Workspace Filtering Tests
//
// Tests for /api/sessions route workspace filtering functionality
// Validates Requirements 5.11-5.15 (sessions route workspace filtering)
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import type { SessionState } from '../src/types.ts';

const TEST_DIR = join(import.meta.dir, 'tmp-sessions-filter-test');
const CONFIG_PATH = join(TEST_DIR, 'workspaces.json');
const PORT = 9877; // Use a different port for testing

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

describe('Sessions Route Workspace Filtering', () => {
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

  test('route accepts workspaceId query parameter (Req 5.11)', async () => {
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
    
    // Simulate sessions data
    const mockSessions: SessionState[] = [
      {
        workflowHash: 'hash-1',
        sessionJsonl: '/sessions/session-1/session.jsonl',
        workspaceId: 'workspace-1',
        chainId: 'chain-1',
        chainIndex: 0,
        status: 'active',
        contextUsagePct: 25,
        previousSession: '',
        topic: 'Test topic',
        messageCount: 10,
        userMessageCount: 5,
        lastMessageAt: '2024-01-01T10:00:00Z',
        lastSummarisedMessageCount: 0,
        lastSummarisedAt: '',
        summaryFile: '',
        firstUserMessage: 'First message',
        lastUserMessage: 'Last message',
        lastAgentMessage: '',
        startTime: '2024-01-01T09:00:00Z',
      },
      {
        workflowHash: 'hash-2',
        sessionJsonl: '/sessions/session-2/session.jsonl',
        workspaceId: 'workspace-2',
        chainId: 'chain-2',
        chainIndex: 0,
        status: 'idle',
        contextUsagePct: 50,
        previousSession: '',
        topic: 'Test topic 2',
        messageCount: 20,
        userMessageCount: 10,
        lastMessageAt: '2024-01-01T11:00:00Z',
        lastSummarisedMessageCount: 0,
        lastSummarisedAt: '',
        summaryFile: '',
        firstUserMessage: 'First message 2',
        lastUserMessage: 'Last message 2',
        lastAgentMessage: '',
        startTime: '2024-01-01T10:00:00Z',
      },
    ];
    
    // Test filtering with workspace-1
    const result1 = filterByWorkspace(mockSessions, 'workspace-1', workspaces);
    expect(result1.status).toBe(200);
    expect(result1.data?.length).toBe(1);
    expect(result1.data?.[0].workspaceId).toBe('workspace-1');
    
    // Test filtering with workspace-2
    const result2 = filterByWorkspace(mockSessions, 'workspace-2', workspaces);
    expect(result2.status).toBe(200);
    expect(result2.data?.length).toBe(1);
    expect(result2.data?.[0].workspaceId).toBe('workspace-2');
    
    // Test filtering with invalid workspace (Req 5.14)
    const result3 = filterByWorkspace(mockSessions, 'invalid-workspace', workspaces);
    expect(result3.status).toBe(404);
    expect(result3.error).toContain("Workspace 'invalid-workspace' does not exist");
    
    // Test no filter (Req 5.15)
    const result4 = filterByWorkspace(mockSessions, undefined, workspaces);
    expect(result4.status).toBe(200);
    expect(result4.data?.length).toBe(2);
  });

  test('validates case-sensitive exact string matching (Req 5.12)', async () => {
    const { DefaultConfigurationLoader } = await import('../src/config/workspace-config.ts');
    const { filterByWorkspace } = await import('../src/routes/helpers/filter.ts');
    
    const loader = new DefaultConfigurationLoader(CONFIG_PATH);
    const workspaces = await loader.loadWorkspaces();
    
    const mockSessions: SessionState[] = [
      {
        workflowHash: 'hash-1',
        sessionJsonl: '/sessions/session-1/session.jsonl',
        workspaceId: 'workspace-1',
        chainId: 'chain-1',
        chainIndex: 0,
        status: 'active',
        contextUsagePct: 25,
        previousSession: '',
        topic: 'Test topic',
        messageCount: 10,
        userMessageCount: 5,
        lastMessageAt: '2024-01-01T10:00:00Z',
        lastSummarisedMessageCount: 0,
        lastSummarisedAt: '',
        summaryFile: '',
        firstUserMessage: 'First message',
        lastUserMessage: 'Last message',
        lastAgentMessage: '',
        startTime: '2024-01-01T09:00:00Z',
      },
    ];
    
    // Case-sensitive test - uppercase should not match
    const result = filterByWorkspace(mockSessions, 'WORKSPACE-1', workspaces);
    expect(result.status).toBe(404);
    expect(result.error).toContain("Workspace 'WORKSPACE-1' does not exist");
  });

  test('returns empty array for valid workspace with no sessions (Req 5.14.1)', async () => {
    const { DefaultConfigurationLoader } = await import('../src/config/workspace-config.ts');
    const { filterByWorkspace } = await import('../src/routes/helpers/filter.ts');
    
    const loader = new DefaultConfigurationLoader(CONFIG_PATH);
    const workspaces = await loader.loadWorkspaces();
    
    const mockSessions: SessionState[] = [
      {
        workflowHash: 'hash-1',
        sessionJsonl: '/sessions/session-1/session.jsonl',
        workspaceId: 'workspace-1',
        chainId: 'chain-1',
        chainIndex: 0,
        status: 'active',
        contextUsagePct: 25,
        previousSession: '',
        topic: 'Test topic',
        messageCount: 10,
        userMessageCount: 5,
        lastMessageAt: '2024-01-01T10:00:00Z',
        lastSummarisedMessageCount: 0,
        lastSummarisedAt: '',
        summaryFile: '',
        firstUserMessage: 'First message',
        lastUserMessage: 'Last message',
        lastAgentMessage: '',
        startTime: '2024-01-01T09:00:00Z',
      },
    ];
    
    // workspace-2 exists but has no sessions
    const result = filterByWorkspace(mockSessions, 'workspace-2', workspaces);
    expect(result.status).toBe(200);
    expect(result.data).toEqual([]);
  });

  test('returns matching sessions for valid workspace (Req 5.13)', async () => {
    const { DefaultConfigurationLoader } = await import('../src/config/workspace-config.ts');
    const { filterByWorkspace } = await import('../src/routes/helpers/filter.ts');
    
    const loader = new DefaultConfigurationLoader(CONFIG_PATH);
    const workspaces = await loader.loadWorkspaces();
    
    const mockSessions: SessionState[] = [
      {
        workflowHash: 'hash-1',
        sessionJsonl: '/sessions/session-1/session.jsonl',
        workspaceId: 'workspace-1',
        chainId: 'chain-1',
        chainIndex: 0,
        status: 'active',
        contextUsagePct: 25,
        previousSession: '',
        topic: 'Test topic',
        messageCount: 10,
        userMessageCount: 5,
        lastMessageAt: '2024-01-01T10:00:00Z',
        lastSummarisedMessageCount: 0,
        lastSummarisedAt: '',
        summaryFile: '',
        firstUserMessage: 'First message',
        lastUserMessage: 'Last message',
        lastAgentMessage: '',
        startTime: '2024-01-01T09:00:00Z',
      },
      {
        workflowHash: 'hash-2',
        sessionJsonl: '/sessions/session-2/session.jsonl',
        workspaceId: 'workspace-1',
        chainId: 'chain-1',
        chainIndex: 1,
        status: 'idle',
        contextUsagePct: 50,
        previousSession: 'hash-1',
        topic: 'Test topic 2',
        messageCount: 20,
        userMessageCount: 10,
        lastMessageAt: '2024-01-01T11:00:00Z',
        lastSummarisedMessageCount: 0,
        lastSummarisedAt: '',
        summaryFile: '',
        firstUserMessage: 'First message 2',
        lastUserMessage: 'Last message 2',
        lastAgentMessage: '',
        startTime: '2024-01-01T10:00:00Z',
      },
      {
        workflowHash: 'hash-3',
        sessionJsonl: '/sessions/session-3/session.jsonl',
        workspaceId: 'workspace-2',
        chainId: 'chain-2',
        chainIndex: 0,
        status: 'complete',
        contextUsagePct: 75,
        previousSession: '',
        topic: 'Test topic 3',
        messageCount: 30,
        userMessageCount: 15,
        lastMessageAt: '2024-01-01T12:00:00Z',
        lastSummarisedMessageCount: 0,
        lastSummarisedAt: '',
        summaryFile: '',
        firstUserMessage: 'First message 3',
        lastUserMessage: 'Last message 3',
        lastAgentMessage: '',
        startTime: '2024-01-01T11:00:00Z',
      },
    ];
    
    // Test filtering returns only matching sessions
    const result = filterByWorkspace(mockSessions, 'workspace-1', workspaces);
    expect(result.status).toBe(200);
    expect(result.data?.length).toBe(2);
    expect(result.data?.every(s => s.workspaceId === 'workspace-1')).toBe(true);
  });
});
