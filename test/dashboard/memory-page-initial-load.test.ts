// test/dashboard/memory-page-initial-load.test.ts
// Unit tests for memory page initial timeline load (Task 8.1)
// Requirements: 2.4

// Import setup file FIRST to inject localStorage mock
import { localStorageMock } from './memory-test-setup.js';

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { renderMemoryPage, initMemoryPage } from '../../src/dashboard/pages/memory.js';
import { setState, getState } from '../../src/dashboard/state.js';

describe('Memory Page Initial Timeline Load (Task 8.1)', () => {
  let container: HTMLElement;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    // Mock fetch FIRST before any state initialization
    originalFetch = global.fetch;
    global.fetch = mock();
    
    // Clear localStorage
    localStorageMock.clear();
    
    // Reset state with empty memory state
    setState({
      chains: [],
      jobChains: [],
      jobs: [],
      pollLog: [],
      systemStatus: null,
      gitStatus: null,
      gitStatuses: [],
      buildQueue: [],
      summariseStatus: {},
      hiddenChains: {},
      currentPage: 'memory',
      drawerChainId: null,
      commitState: null,
      toasts: [],
      workspaceFilter: {
        selectedWorkspaceId: null,
        availableWorkspaces: [],
      },
      analytics: {
        range: '7d',
        loading: false,
        workspaceId: '',
        performance: null,
        cost: null,
        bottlenecks: null,
      },
      // No memory state initially - let initMemoryPage create it
    });

    // Create container and mount memory page HTML
    container = document.createElement('div');
    container.innerHTML = renderMemoryPage();
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
    global.fetch = originalFetch;
  });

  describe('Requirement 2.4 — Initial timeline load on page mount', () => {
    it('should trigger GET /api/memory/list when page initializes in default view', async () => {
      // Mock successful API response
      (global.fetch as ReturnType<typeof mock>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [], nextCursor: null, total: 0 }),
      } as Response);

      // Initialize memory page - should trigger initial fetch
      initMemoryPage();

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 0));

      // Verify fetch was called
      expect(global.fetch).toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/memory/list')
      );
    });

    it('should NOT trigger fetch when search query is active', async () => {
      // Set up state with an active search query
      setState({
        memory: {
          memories: [],
          cursor: null,
          total: 0,
          searchQuery: 'test query',  // Active search
          loading: false,
          error: null,
          workspaceId: '',
          chainId: '',
          agentId: '',
        },
      });

      // Mock fetch (should not be called)
      (global.fetch as ReturnType<typeof mock>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [], nextCursor: null, total: 0 }),
      } as Response);

      // Initialize memory page
      initMemoryPage();

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 0));

      // Verify fetch was NOT called (search is active)
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should complete loading after API call finishes', async () => {
      // Mock API response
      (global.fetch as ReturnType<typeof mock>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [], nextCursor: null, total: 0 }),
      } as Response);

      // Initialize memory page
      initMemoryPage();

      // Wait for async operations to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      // Check that loading state is false (completed)
      const finalState = getState();
      expect(finalState.memory?.loading).toBe(false);
      expect(finalState.memory?.error).toBeNull();
    });

    it('should respect current filters in initial API call', async () => {
      // Set up state with filters already applied
      setState({
        memory: {
          memories: [],
          cursor: null,
          total: 0,
          searchQuery: '',
          loading: false,
          error: null,
          workspaceId: 'workspace-123',
          chainId: 'chain-456',
          agentId: 'agent-789',
        },
      });

      // Mock successful API response
      (global.fetch as ReturnType<typeof mock>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [], nextCursor: null, total: 0 }),
      } as Response);

      // Initialize memory page
      initMemoryPage();

      // Wait for multiple event loop ticks
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify fetch was called with all filters
      expect(global.fetch).toHaveBeenCalled();
      const mockFn = global.fetch as ReturnType<typeof mock>;
      const callUrl = mockFn.mock.calls[0][0] as string;
      
      expect(callUrl).toContain('workspaceId=workspace-123');
      expect(callUrl).toContain('chainId=chain-456');
      expect(callUrl).toContain('agentId=agent-789');
    });
  });
});
