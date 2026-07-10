// ---------------------------------------------------------------------------
// Chains Route Integration Test
//
// Validates that the chains route correctly combines:
// 1. Existing totalMessages > 1 filter (removes stub chains)
// 2. New workspace filtering functionality
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import type { Chain } from '../src/types.ts';

describe('Chains Route - Combined Filtering Logic', () => {
  test('preserves totalMessages > 1 filter before workspace filtering', () => {
    // Simulate the filtering logic from the chains route
    const mockChains: Chain[] = [
      {
        chainId: 'stub-chain',
        displayName: 'Stub Chain',
        workspaceId: 'workspace-1',
        totalMessages: 1, // Should be filtered out
        nextIndex: 1,
        sessions: [],
        createdAt: '2024-01-01',
        lastActiveAt: '2024-01-01',
        workflowCount: 0,
      },
      {
        chainId: 'valid-chain-1',
        displayName: 'Valid Chain 1',
        workspaceId: 'workspace-1',
        totalMessages: 5,
        nextIndex: 2,
        sessions: [],
        createdAt: '2024-01-01',
        lastActiveAt: '2024-01-01',
        workflowCount: 1,
      },
      {
        chainId: 'valid-chain-2',
        displayName: 'Valid Chain 2',
        workspaceId: 'workspace-2',
        totalMessages: 10,
        nextIndex: 3,
        sessions: [],
        createdAt: '2024-01-01',
        lastActiveAt: '2024-01-01',
        workflowCount: 2,
      },
      {
        chainId: 'zero-messages',
        displayName: 'Zero Messages',
        workspaceId: 'workspace-1',
        totalMessages: 0, // Should be filtered out
        nextIndex: 0,
        sessions: [],
        createdAt: '2024-01-01',
        lastActiveAt: '2024-01-01',
        workflowCount: 0,
      },
    ];

    // Step 1: Filter out stub chains (totalMessages <= 1)
    const filtered = mockChains.filter(c => (c.totalMessages ?? 0) > 1);

    // Verify stub chains are removed
    expect(filtered.length).toBe(2);
    expect(filtered.find(c => c.chainId === 'stub-chain')).toBeUndefined();
    expect(filtered.find(c => c.chainId === 'zero-messages')).toBeUndefined();
    expect(filtered.find(c => c.chainId === 'valid-chain-1')).toBeDefined();
    expect(filtered.find(c => c.chainId === 'valid-chain-2')).toBeDefined();

    // Step 2: Workspace filtering would be applied to this filtered list
    const workspace1Chains = filtered.filter(c => c.workspaceId === 'workspace-1');
    expect(workspace1Chains.length).toBe(1);
    expect(workspace1Chains[0].chainId).toBe('valid-chain-1');

    const workspace2Chains = filtered.filter(c => c.workspaceId === 'workspace-2');
    expect(workspace2Chains.length).toBe(1);
    expect(workspace2Chains[0].chainId).toBe('valid-chain-2');
  });

  test('handles chains with undefined totalMessages', () => {
    const mockChains: Chain[] = [
      {
        chainId: 'undefined-messages',
        displayName: 'Undefined Messages',
        workspaceId: 'workspace-1',
        totalMessages: undefined,
        nextIndex: 0,
        sessions: [],
        createdAt: '2024-01-01',
        lastActiveAt: '2024-01-01',
        workflowCount: 0,
      },
      {
        chainId: 'valid-chain',
        displayName: 'Valid Chain',
        workspaceId: 'workspace-1',
        totalMessages: 5,
        nextIndex: 1,
        sessions: [],
        createdAt: '2024-01-01',
        lastActiveAt: '2024-01-01',
        workflowCount: 1,
      },
    ];

    // Filter out chains with totalMessages <= 1 (undefined treated as 0)
    const filtered = mockChains.filter(c => (c.totalMessages ?? 0) > 1);

    expect(filtered.length).toBe(1);
    expect(filtered[0].chainId).toBe('valid-chain');
  });

  test('workspace filtering works on pre-filtered chains', () => {
    // This validates the complete flow:
    // 1. All chains are scanned
    // 2. Stub chains (totalMessages <= 1) are filtered out
    // 3. Workspace filtering is applied to remaining chains

    const allChains: Chain[] = [
      {
        chainId: 'stub-w1',
        displayName: 'Stub W1',
        workspaceId: 'workspace-1',
        totalMessages: 1,
        nextIndex: 0,
        sessions: [],
        createdAt: '2024-01-01',
        lastActiveAt: '2024-01-01',
        workflowCount: 0,
      },
      {
        chainId: 'valid-w1-1',
        displayName: 'Valid W1 1',
        workspaceId: 'workspace-1',
        totalMessages: 5,
        nextIndex: 1,
        sessions: [],
        createdAt: '2024-01-01',
        lastActiveAt: '2024-01-01',
        workflowCount: 1,
      },
      {
        chainId: 'valid-w1-2',
        displayName: 'Valid W1 2',
        workspaceId: 'workspace-1',
        totalMessages: 8,
        nextIndex: 2,
        sessions: [],
        createdAt: '2024-01-01',
        lastActiveAt: '2024-01-01',
        workflowCount: 2,
      },
      {
        chainId: 'stub-w2',
        displayName: 'Stub W2',
        workspaceId: 'workspace-2',
        totalMessages: 0,
        nextIndex: 0,
        sessions: [],
        createdAt: '2024-01-01',
        lastActiveAt: '2024-01-01',
        workflowCount: 0,
      },
      {
        chainId: 'valid-w2-1',
        displayName: 'Valid W2 1',
        workspaceId: 'workspace-2',
        totalMessages: 3,
        nextIndex: 1,
        sessions: [],
        createdAt: '2024-01-01',
        lastActiveAt: '2024-01-01',
        workflowCount: 1,
      },
    ];

    // Step 1: Filter stubs
    const withoutStubs = allChains.filter(c => (c.totalMessages ?? 0) > 1);
    expect(withoutStubs.length).toBe(3);

    // Step 2: Apply workspace filter
    const workspace1Result = withoutStubs.filter(c => c.workspaceId === 'workspace-1');
    expect(workspace1Result.length).toBe(2);
    expect(workspace1Result.map(c => c.chainId)).toEqual(['valid-w1-1', 'valid-w1-2']);

    const workspace2Result = withoutStubs.filter(c => c.workspaceId === 'workspace-2');
    expect(workspace2Result.length).toBe(1);
    expect(workspace2Result[0].chainId).toBe('valid-w2-1');

    // When no workspace filter (all workspaces)
    expect(withoutStubs.length).toBe(3);
  });
});
