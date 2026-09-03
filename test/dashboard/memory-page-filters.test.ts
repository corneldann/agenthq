// test/dashboard/memory-page-filters.test.ts
// Unit tests for memory page scope filter bar (Task 6.2)
// Requirements: 2.2

// Import setup file FIRST to inject localStorage mock
import { localStorageMock } from './memory-test-setup.js';

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { renderMemoryPage, initMemoryPage } from '../../src/dashboard/pages/memory.js';
import { setState, getState } from '../../src/dashboard/state.js';
import type { AppState } from '../../src/dashboard/types.js';

describe('Memory Page Scope Filter Bar', () => {
  let container: HTMLElement;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    // Clear localStorage
    localStorageMock.clear();
    
    // Reset state
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
        availableWorkspaces: [
          { id: 'workspace-1', displayName: 'Workspace 1' },
          { id: 'workspace-2', displayName: 'Workspace 2' },
        ],
      },
      analytics: {
        range: '7d',
        loading: false,
        workspaceId: '',
        performance: null,
        cost: null,
        bottlenecks: null,
      },
      memory: {
        memories: [],
        cursor: null,
        total: 0,
        searchQuery: '',
        loading: false,
        error: null,
        workspaceId: '',
        chainId: '',
        agentId: '',
      },
    });

    // Create container and mount memory page
    container = document.createElement('div');
    container.innerHTML = renderMemoryPage();
    document.body.appendChild(container);

    // Mock fetch
    originalFetch = global.fetch;
    global.fetch = (mock() as unknown as typeof global.fetch) as unknown as typeof global.fetch;
  });

  afterEach(() => {
    document.body.removeChild(container);
    global.fetch = originalFetch;
  });

  describe('Requirement 2.2 — Scope filter bar rendering', () => {
    it('should render workspace dropdown', () => {
      const workspaceSelect = container.querySelector('#memory-workspace-filter');
      expect(workspaceSelect).not.toBeNull();
      expect(workspaceSelect?.tagName).toBe('SELECT');
    });

    it('should render chain dropdown', () => {
      const chainSelect = container.querySelector('#memory-chain-filter');
      expect(chainSelect).not.toBeNull();
      expect(chainSelect?.tagName).toBe('SELECT');
    });

    it('should render agent dropdown', () => {
      const agentSelect = container.querySelector('#memory-agent-filter');
      expect(agentSelect).not.toBeNull();
      expect(agentSelect?.tagName).toBe('SELECT');
    });

    it('should have "All Workspaces" as default option', () => {
      const workspaceSelect = container.querySelector('#memory-workspace-filter') as HTMLSelectElement;
      expect(workspaceSelect.options[0].value).toBe('');
      expect(workspaceSelect.options[0].textContent).toBe('All Workspaces');
    });

    it('should have "All Chains" as default option', () => {
      const chainSelect = container.querySelector('#memory-chain-filter') as HTMLSelectElement;
      expect(chainSelect.options[0].value).toBe('');
      expect(chainSelect.options[0].textContent).toBe('All Chains');
    });

    it('should have "All Agents" as default option', () => {
      const agentSelect = container.querySelector('#memory-agent-filter') as HTMLSelectElement;
      expect(agentSelect.options[0].value).toBe('');
      expect(agentSelect.options[0].textContent).toBe('All Agents');
    });
  });

  describe('Requirement 2.2 — Filter change handlers', () => {
    beforeEach(() => {
      initMemoryPage();
    });

    it('should update AppState when workspace filter changes', async () => {
      const workspaceSelect = container.querySelector('#memory-workspace-filter') as HTMLSelectElement;
      
      // Mock successful API response
      (global.fetch as unknown as ReturnType<typeof mock>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [], nextCursor: null, total: 0 }),
      } as Response);

      // Change workspace selection
      workspaceSelect.value = 'workspace-1';
      workspaceSelect.dispatchEvent(new Event('change'));

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 0));

      const state = getState();
      expect(state.memory?.workspaceId).toBe('workspace-1');
    });

    it('should update AppState when chain filter changes', async () => {
      const chainSelect = container.querySelector('#memory-chain-filter') as HTMLSelectElement;
      
      // Mock successful API response
      (global.fetch as unknown as ReturnType<typeof mock>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [], nextCursor: null, total: 0 }),
      } as Response);

      // Add a chain option for testing
      const option = document.createElement('option');
      option.value = 'chain-123';
      option.textContent = 'chain-123';
      chainSelect.appendChild(option);

      // Change chain selection
      chainSelect.value = 'chain-123';
      chainSelect.dispatchEvent(new Event('change'));

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 0));

      const state = getState();
      expect(state.memory?.chainId).toBe('chain-123');
    });

    it('should update AppState when agent filter changes', async () => {
      const agentSelect = container.querySelector('#memory-agent-filter') as HTMLSelectElement;
      
      // Mock successful API response
      (global.fetch as unknown as ReturnType<typeof mock>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [], nextCursor: null, total: 0 }),
      } as Response);

      // Add an agent option for testing
      const option = document.createElement('option');
      option.value = 'agent-456';
      option.textContent = 'agent-456';
      agentSelect.appendChild(option);

      // Change agent selection
      agentSelect.value = 'agent-456';
      agentSelect.dispatchEvent(new Event('change'));

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 0));

      const state = getState();
      expect(state.memory?.agentId).toBe('agent-456');
    });
  });

  describe('Requirement 2.2 — API calls on filter change', () => {
    beforeEach(() => {
      initMemoryPage();
    });

    it('should call GET /api/memory/list when workspace filter changes', async () => {
      const workspaceSelect = container.querySelector('#memory-workspace-filter') as HTMLSelectElement;
      
      // Mock successful API response
      (global.fetch as unknown as ReturnType<typeof mock>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [], nextCursor: null, total: 0 }),
      } as Response);

      // Change workspace selection
      workspaceSelect.value = 'workspace-1';
      workspaceSelect.dispatchEvent(new Event('change'));

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/memory/list')
      );
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('workspaceId=workspace-1')
      );
    });

    it('should call GET /api/memory/list when chain filter changes', async () => {
      const chainSelect = container.querySelector('#memory-chain-filter') as HTMLSelectElement;
      
      // Mock successful API response
      (global.fetch as unknown as ReturnType<typeof mock>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [], nextCursor: null, total: 0 }),
      } as Response);

      // Add a chain option
      const option = document.createElement('option');
      option.value = 'chain-123';
      option.textContent = 'chain-123';
      chainSelect.appendChild(option);

      // Change chain selection
      chainSelect.value = 'chain-123';
      chainSelect.dispatchEvent(new Event('change'));

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/memory/list')
      );
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('chainId=chain-123')
      );
    });

    it('should call GET /api/memory/list when agent filter changes', async () => {
      const agentSelect = container.querySelector('#memory-agent-filter') as HTMLSelectElement;
      
      // Mock successful API response
      (global.fetch as unknown as ReturnType<typeof mock>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memories: [], nextCursor: null, total: 0 }),
      } as Response);

      // Add an agent option
      const option = document.createElement('option');
      option.value = 'agent-456';
      option.textContent = 'agent-456';
      agentSelect.appendChild(option);

      // Change agent selection
      agentSelect.value = 'agent-456';
      agentSelect.dispatchEvent(new Event('change'));

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/memory/list')
      );
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('agentId=agent-456')
      );
    });

    it('should include all active filters in API call', async () => {
      // Mock successful API response
      (global.fetch as unknown as ReturnType<typeof mock>).mockResolvedValue({
        ok: true,
        json: async () => ({ memories: [], nextCursor: null, total: 0 }),
      } as Response);

      const workspaceSelect = container.querySelector('#memory-workspace-filter') as HTMLSelectElement;
      const chainSelect = container.querySelector('#memory-chain-filter') as HTMLSelectElement;
      const agentSelect = container.querySelector('#memory-agent-filter') as HTMLSelectElement;

      // Add options
      const chainOption = document.createElement('option');
      chainOption.value = 'chain-123';
      chainOption.textContent = 'chain-123';
      chainSelect.appendChild(chainOption);

      const agentOption = document.createElement('option');
      agentOption.value = 'agent-456';
      agentOption.textContent = 'agent-456';
      agentSelect.appendChild(agentOption);

      // Set all filters
      workspaceSelect.value = 'workspace-1';
      workspaceSelect.dispatchEvent(new Event('change'));
      await new Promise(resolve => setTimeout(resolve, 0));

      chainSelect.value = 'chain-123';
      chainSelect.dispatchEvent(new Event('change'));
      await new Promise(resolve => setTimeout(resolve, 0));

      agentSelect.value = 'agent-456';
      agentSelect.dispatchEvent(new Event('change'));
      await new Promise(resolve => setTimeout(resolve, 0));

      // Check last call includes all filters
      const mockFn = global.fetch as unknown as ReturnType<typeof mock>;
      const lastCall = mockFn.mock.calls[mockFn.mock.calls.length - 1][0] as string;
      
      expect(lastCall).toContain('workspaceId=workspace-1');
      expect(lastCall).toContain('chainId=chain-123');
      expect(lastCall).toContain('agentId=agent-456');
    });
  });

  describe('Filter population', () => {
    it('should populate workspace options from AppState', () => {
      initMemoryPage();

      const workspaceSelect = container.querySelector('#memory-workspace-filter') as HTMLSelectElement;
      
      // Should have "All Workspaces" + 2 workspace options
      expect(workspaceSelect.options.length).toBe(3);
      expect(workspaceSelect.options[1].value).toBe('workspace-1');
      expect(workspaceSelect.options[1].textContent).toBe('Workspace 1');
      expect(workspaceSelect.options[2].value).toBe('workspace-2');
      expect(workspaceSelect.options[2].textContent).toBe('Workspace 2');
    });

    it('should populate chain options from chains array', () => {
      // Add chains to state
      setState({
        chains: [
          {
            chainId: 'chain-1',
            displayName: 'Chain 1',
            nextIndex: 0,
            sessions: [],
            totalMessages: 0,
            createdAt: '2024-01-01T00:00:00Z',
            lastActiveAt: '2024-01-01T00:00:00Z',
            workspaceId: 'workspace-1',
          },
          {
            chainId: 'chain-2',
            displayName: 'Chain 2',
            nextIndex: 0,
            sessions: [],
            totalMessages: 0,
            createdAt: '2024-01-01T00:00:00Z',
            lastActiveAt: '2024-01-01T00:00:00Z',
            workspaceId: 'workspace-1',
          },
        ],
      });

      initMemoryPage();

      const chainSelect = container.querySelector('#memory-chain-filter') as HTMLSelectElement;
      
      // Should have "All Chains" + 2 chain options
      expect(chainSelect.options.length).toBe(3);
      expect(chainSelect.options[1].value).toBe('chain-1');
      expect(chainSelect.options[2].value).toBe('chain-2');
    });

    it('should populate agent options from jobs array', () => {
      // Add jobs to state
      setState({
        jobs: [
          {
            id: 'job-1',
            name: 'Job 1',
            jobChain: 'jc-1',
            sessionChainId: 'chain-1',
            timestamp: '2024-01-01T00:00:00Z',
            type: 'type-1',
            agent: 'agent-1',
            status: 'done',
            lines: 10,
            lastLine: 'last',
            hasLog: true,
            logError: false,
            mdFile: 'file.md',
            logFile: 'log.txt',
            agentDone: '2024-01-01T00:00:01Z',
            sizeBytes: 1000,
            workspaceId: 'workspace-1',
          },
          {
            id: 'job-2',
            name: 'Job 2',
            jobChain: 'jc-2',
            sessionChainId: 'chain-2',
            timestamp: '2024-01-01T00:00:00Z',
            type: 'type-2',
            agent: 'agent-2',
            status: 'running',
            lines: 5,
            lastLine: 'last',
            hasLog: true,
            logError: false,
            mdFile: 'file2.md',
            logFile: 'log2.txt',
            agentDone: '2024-01-01T00:00:01Z',
            sizeBytes: 500,
            workspaceId: 'workspace-1',
          },
        ],
      });

      initMemoryPage();

      const agentSelect = container.querySelector('#memory-agent-filter') as HTMLSelectElement;
      
      // Should have "All Agents" + 2 agent options
      expect(agentSelect.options.length).toBe(3);
      expect(agentSelect.options[1].value).toBe('agent-1');
      expect(agentSelect.options[2].value).toBe('agent-2');
    });
  });
});
