// pages/memory.ts — Memory browser page with tab navigation
// Phase 6.4 Memory Browser
// Requirements: 2.1, 2.2, 2.3, 3.1

import { esc } from '../utils.js';
import { setState, getState } from '../state.js';
import type { MemoryPageState } from '../types.js';

// ---------------------------------------------------------------------------
// Filter handlers and API integration (Requirement 2.2)
// ---------------------------------------------------------------------------

/**
 * Fetches memory list with current filter parameters.
 * Calls GET /api/memory/list with workspaceId, chainId, agentId filters.
 * Updates AppState memory slice with results.
 *
 * Requirement 2.2: Trigger GET /api/memory/list on filter change
 */
async function fetchMemoryList(): Promise<void> {
  const state = getState();
  const memoryState = state.memory;

  if (!memoryState) {
    // Initialize memory state if not present
    setState({
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
    return;
  }

  // Set loading state
  setState({
    memory: { ...memoryState, loading: true, error: null },
  });

  try {
    // Build query params
    const params = new URLSearchParams();
    if (memoryState.workspaceId) {
      params.set('workspaceId', memoryState.workspaceId);
    }
    if (memoryState.chainId) {
      params.set('chainId', memoryState.chainId);
    }
    if (memoryState.agentId) {
      params.set('agentId', memoryState.agentId);
    }
    params.set('pageSize', '50');

    const url = `/api/memory/list?${params.toString()}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as {
      memories: Array<unknown>;
      nextCursor: string | null;
      total: number;
    };

    // Update state with results
    const updatedMemoryState = getState().memory;
    if (updatedMemoryState) {
      setState({
        memory: {
          ...updatedMemoryState,
          memories: data.memories as MemoryPageState['memories'],
          cursor: data.nextCursor,
          total: data.total,
          loading: false,
        },
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const updatedMemoryState = getState().memory;
    if (updatedMemoryState) {
      setState({
        memory: {
          ...updatedMemoryState,
          loading: false,
          error: message,
        },
      });
    }
  }
}

/**
 * Handles workspace filter change.
 * Updates memory state and triggers API fetch.
 *
 * Requirement 2.2: Wire change handlers to update AppState memory slice
 */
function handleWorkspaceFilterChange(workspaceId: string): void {
  const state = getState();
  const memoryState = state.memory;

  if (memoryState) {
    setState({
      memory: { ...memoryState, workspaceId },
    });
    void fetchMemoryList();
  }
}

/**
 * Handles chain filter change.
 * Updates memory state and triggers API fetch.
 *
 * Requirement 2.2: Wire change handlers to update AppState memory slice
 */
function handleChainFilterChange(chainId: string): void {
  const state = getState();
  const memoryState = state.memory;

  if (memoryState) {
    setState({
      memory: { ...memoryState, chainId },
    });
    void fetchMemoryList();
  }
}

/**
 * Handles agent filter change.
 * Updates memory state and triggers API fetch.
 *
 * Requirement 2.2: Wire change handlers to update AppState memory slice
 */
function handleAgentFilterChange(agentId: string): void {
  const state = getState();
  const memoryState = state.memory;

  if (memoryState) {
    setState({
      memory: { ...memoryState, agentId },
    });
    void fetchMemoryList();
  }
}

// ---------------------------------------------------------------------------
// Search handlers and debounce logic (Requirement 2.3)
// ---------------------------------------------------------------------------

/** Timeout ID for debounce mechanism. */
let _searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Fetches memories matching the given search query.
 * Calls GET /api/memory/search with query and workspaceId.
 * Replaces timeline with search results.
 *
 * Requirement 2.3: Trigger GET /api/memory/search on debounced query
 */
async function fetchMemorySearch(query: string): Promise<void> {
  const state = getState();
  const memoryState = state.memory;

  if (!memoryState) return;

  // Set loading state
  setState({
    memory: { ...memoryState, loading: true, error: null, searchQuery: query },
  });

  try {
    // Build query params
    const params = new URLSearchParams();
    params.set('q', query);
    
    if (memoryState.workspaceId) {
      params.set('workspaceId', memoryState.workspaceId);
    }
    
    params.set('limit', '20'); // Default limit from design

    const url = `/api/memory/search?${params.toString()}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const memories = await response.json() as Array<unknown>;

    // Update state with search results
    const updatedMemoryState = getState().memory;
    if (updatedMemoryState) {
      setState({
        memory: {
          ...updatedMemoryState,
          memories: memories as MemoryPageState['memories'],
          cursor: null, // Search results don't have pagination cursor
          total: memories.length,
          loading: false,
        },
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const updatedMemoryState = getState().memory;
    if (updatedMemoryState) {
      setState({
        memory: {
          ...updatedMemoryState,
          loading: false,
          error: message,
        },
      });
    }
  }
}

/**
 * Handles search input changes with 300ms debounce.
 * If input is cleared, returns to default list view.
 *
 * Requirement 2.3: Implement 300ms debounce on input event
 * Requirement 2.3: Clear search and return to list view when input cleared
 */
function handleSearchInput(value: string): void {
  // Clear any existing debounce timer
  if (_searchDebounceTimer !== null) {
    clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = null;
  }

  // If input is cleared, return to list view immediately
  if (value.trim() === '') {
    const state = getState();
    const memoryState = state.memory;
    
    if (memoryState && memoryState.searchQuery !== '') {
      setState({
        memory: { ...memoryState, searchQuery: '' },
      });
      void fetchMemoryList();
    }
    return;
  }

  // Debounce search for 300ms
  _searchDebounceTimer = setTimeout(() => {
    void fetchMemorySearch(value.trim());
    _searchDebounceTimer = null;
  }, 300);
}

/**
 * Populates filter dropdowns with available options.
 * For workspace: uses workspaceFilter.availableWorkspaces from AppState.
 * For chain and agent: extracts unique values from chains array.
 */
function populateFilters(): void {
  const state = getState();
  
  // Populate workspace dropdown
  const workspaceSelect = document.getElementById('memory-workspace-filter') as HTMLSelectElement | null;
  if (workspaceSelect && state.workspaceFilter) {
    // Clear existing options except "All Workspaces"
    while (workspaceSelect.options.length > 1) {
      workspaceSelect.remove(1);
    }
    
    // Add workspace options
    for (const workspace of state.workspaceFilter.availableWorkspaces) {
      const option = document.createElement('option');
      option.value = workspace.id;
      option.textContent = workspace.displayName;
      workspaceSelect.appendChild(option);
    }
  }

  // Populate chain dropdown
  const chainSelect = document.getElementById('memory-chain-filter') as HTMLSelectElement | null;
  if (chainSelect && state.chains) {
    // Clear existing options except "All Chains"
    while (chainSelect.options.length > 1) {
      chainSelect.remove(1);
    }
    
    // Extract unique chain IDs
    const uniqueChains = new Set<string>();
    for (const chain of state.chains) {
      uniqueChains.add(chain.chainId);
    }
    
    // Add chain options
    for (const chainId of uniqueChains) {
      const option = document.createElement('option');
      option.value = chainId;
      option.textContent = chainId;
      chainSelect.appendChild(option);
    }
  }

  // Populate agent dropdown
  const agentSelect = document.getElementById('memory-agent-filter') as HTMLSelectElement | null;
  if (agentSelect && state.jobs) {
    // Clear existing options except "All Agents"
    while (agentSelect.options.length > 1) {
      agentSelect.remove(1);
    }
    
    // Extract unique agent IDs
    const uniqueAgents = new Set<string>();
    for (const job of state.jobs) {
      if (job.agent) {
        uniqueAgents.add(job.agent);
      }
    }
    
    // Add agent options
    for (const agentId of uniqueAgents) {
      const option = document.createElement('option');
      option.value = agentId;
      option.textContent = agentId;
      agentSelect.appendChild(option);
    }
  }
}

// ---------------------------------------------------------------------------
// Tab state (module-level, managed by initMemoryPage)
// ---------------------------------------------------------------------------

let _activeTab: 'timeline' | 'graph' = 'timeline';

// ---------------------------------------------------------------------------
// renderMemoryPage — pure shell HTML (Requirement 2.1)
// Returns static HTML that initMemoryPage() populates with data.
// Uses esc() for any dynamic values inserted into the template.
// ---------------------------------------------------------------------------

/**
 * Returns the shell HTML structure for the Memory page.
 * No data fetching occurs here — call initMemoryPage() after mounting.
 *
 * Tab navigation follows ARIA authoring practices:
 * - role="tablist" on container
 * - role="tab" on buttons with aria-selected, aria-controls
 * - role="tabpanel" on panel containers with aria-labelledby
 * - Arrow Left/Right for previous/next tab
 * - Home for first tab, End for last tab
 *
 * Requirements: 2.1, 3.1
 */
export function renderMemoryPage(): string {
  return `
<div class="memory-page" id="memory-root">
  <header class="memory-page__header" style="margin-bottom:16px">
    <div class="memory-page__tabs" role="tablist" aria-label="Memory browser tabs"
      style="display:flex;gap:4px;border-bottom:1px solid var(--md-outline,#6c7086)">
      <button
        role="tab"
        id="tab-timeline"
        aria-selected="true"
        aria-controls="panel-timeline"
        tabindex="0"
        style="padding:8px 16px;background:none;border:none;border-bottom:2px solid var(--md-primary,#89b4fa);color:var(--md-primary,#89b4fa);font-size:13px;font-weight:500;cursor:pointer;transition:all 0.15s">
        Timeline
      </button>
      <button
        role="tab"
        id="tab-graph"
        aria-selected="false"
        aria-controls="panel-graph"
        tabindex="-1"
        style="padding:8px 16px;background:none;border:none;border-bottom:2px solid transparent;color:var(--md-on-surf-var,#a6adc8);font-size:13px;font-weight:500;cursor:pointer;transition:all 0.15s">
        Graph
      </button>
    </div>
  </header>

  <div class="memory-page__body">
    <div
      role="tabpanel"
      id="panel-timeline"
      aria-labelledby="tab-timeline"
      tabindex="0"
      style="outline:none">
      
      <!-- Scope filter bar (Requirement 2.2) -->
      <div class="memory-filters" style="display:flex;gap:12px;margin-bottom:16px;padding:12px;background:var(--md-surf-low,#202030);border-radius:8px">
        
        <!-- Workspace filter -->
        <div class="memory-filters__group" style="flex:1;min-width:0">
          <label for="memory-workspace-filter" style="display:block;font-size:11px;font-weight:500;color:var(--md-on-surf-var,#a6adc8);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">
            Workspace
          </label>
          <select
            id="memory-workspace-filter"
            class="memory-filters__select"
            style="width:100%;padding:6px 8px;background:var(--md-surf,#24273a);color:var(--md-on-surf,#cdd6f4);border:1px solid var(--md-outline,#6c7086);border-radius:4px;font-size:13px;cursor:pointer">
            <option value="">All Workspaces</option>
          </select>
        </div>

        <!-- Chain filter -->
        <div class="memory-filters__group" style="flex:1;min-width:0">
          <label for="memory-chain-filter" style="display:block;font-size:11px;font-weight:500;color:var(--md-on-surf-var,#a6adc8);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">
            Chain
          </label>
          <select
            id="memory-chain-filter"
            class="memory-filters__select"
            style="width:100%;padding:6px 8px;background:var(--md-surf,#24273a);color:var(--md-on-surf,#cdd6f4);border:1px solid var(--md-outline,#6c7086);border-radius:4px;font-size:13px;cursor:pointer">
            <option value="">All Chains</option>
          </select>
        </div>

        <!-- Agent filter -->
        <div class="memory-filters__group" style="flex:1;min-width:0">
          <label for="memory-agent-filter" style="display:block;font-size:11px;font-weight:500;color:var(--md-on-surf-var,#a6adc8);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">
            Agent
          </label>
          <select
            id="memory-agent-filter"
            class="memory-filters__select"
            style="width:100%;padding:6px 8px;background:var(--md-surf,#24273a);color:var(--md-on-surf,#cdd6f4);border:1px solid var(--md-outline,#6c7086);border-radius:4px;font-size:13px;cursor:pointer">
            <option value="">All Agents</option>
          </select>
        </div>
      </div>

      <!-- Search input with debounce (Requirement 2.3) -->
      <div class="memory-search" style="margin-bottom:16px">
        <label for="memory-search-input" class="sr-only">Search memories</label>
        <input
          type="text"
          id="memory-search-input"
          class="memory-search__input"
          placeholder="Search memories..."
          aria-label="Search memories"
          style="width:100%;padding:10px 12px;background:var(--md-surf,#24273a);color:var(--md-on-surf,#cdd6f4);border:1px solid var(--md-outline,#6c7086);border-radius:6px;font-size:14px;outline:none;transition:border-color 0.15s"
        />
      </div>

      <p style="color:var(--md-on-surf-var,#a6adc8);font-size:13px">Timeline panel — not yet implemented</p>
    </div>

    <div
      role="tabpanel"
      id="panel-graph"
      aria-labelledby="tab-graph"
      hidden
      tabindex="0"
      style="outline:none">
      <p style="color:var(--md-on-surf-var,#a6adc8);font-size:13px">Graph panel — not yet implemented</p>
    </div>
  </div>

  <aside class="memory-page__sidebar" aria-label="Memory reflection panel" style="margin-top:20px">
    <p style="color:var(--md-on-surf-var,#a6adc8);font-size:13px">Reflect panel — not yet implemented</p>
  </aside>
</div>
`.trim();
}

// ---------------------------------------------------------------------------
// Tab switching logic (Requirement 3.1)
// ---------------------------------------------------------------------------

/**
 * Activates the specified tab and shows its corresponding panel.
 * Updates ARIA attributes and applies visual styles.
 */
function activateTab(tabId: 'timeline' | 'graph'): void {
  _activeTab = tabId;

  const timelineTab = document.getElementById('tab-timeline');
  const graphTab = document.getElementById('tab-graph');
  const timelinePanel = document.getElementById('panel-timeline');
  const graphPanel = document.getElementById('panel-graph');

  if (!timelineTab || !graphTab || !timelinePanel || !graphPanel) return;

  // Update tab buttons
  if (tabId === 'timeline') {
    timelineTab.setAttribute('aria-selected', 'true');
    timelineTab.setAttribute('tabindex', '0');
    timelineTab.style.borderBottomColor = 'var(--md-primary,#89b4fa)';
    timelineTab.style.color = 'var(--md-primary,#89b4fa)';

    graphTab.setAttribute('aria-selected', 'false');
    graphTab.setAttribute('tabindex', '-1');
    graphTab.style.borderBottomColor = 'transparent';
    graphTab.style.color = 'var(--md-on-surf-var,#a6adc8)';

    // Show timeline panel, hide graph panel
    timelinePanel.hidden = false;
    graphPanel.hidden = true;

    // Move focus to the active tab
    timelineTab.focus();
  } else {
    graphTab.setAttribute('aria-selected', 'true');
    graphTab.setAttribute('tabindex', '0');
    graphTab.style.borderBottomColor = 'var(--md-primary,#89b4fa)';
    graphTab.style.color = 'var(--md-primary,#89b4fa)';

    timelineTab.setAttribute('aria-selected', 'false');
    timelineTab.setAttribute('tabindex', '-1');
    timelineTab.style.borderBottomColor = 'transparent';
    timelineTab.style.color = 'var(--md-on-surf-var,#a6adc8)';

    // Show graph panel, hide timeline panel
    graphPanel.hidden = false;
    timelinePanel.hidden = true;

    // Move focus to the active tab
    graphTab.focus();
  }
}

// ---------------------------------------------------------------------------
// Keyboard navigation (Arrow keys, Home, End) — Requirement 3.1
// ---------------------------------------------------------------------------

function handleTabKeydown(e: Event): void {
  // Duck typing check - verify event has a 'key' property instead of instanceof
  // (happy-dom's KeyboardEvent may not pass instanceof check)
  if (!('key' in e)) return;
  
  const currentTab = e.target as HTMLElement;
  if (!currentTab || currentTab.getAttribute('role') !== 'tab') return;

  const tablist = currentTab.closest('[role="tablist"]');
  if (!tablist) return;

  const tabs = Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]'));
  const currentIndex = tabs.indexOf(currentTab);

  let targetIndex = currentIndex;

  // Type assertion after duck typing check
  const key = (e as { key: string }).key;

  switch (key) {
    case 'ArrowLeft':
      e.preventDefault();
      targetIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
      break;
    case 'ArrowRight':
      e.preventDefault();
      targetIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
      break;
    case 'Home':
      e.preventDefault();
      targetIndex = 0;
      break;
    case 'End':
      e.preventDefault();
      targetIndex = tabs.length - 1;
      break;
    default:
      return;
  }

  const targetTab = tabs[targetIndex];
  if (!targetTab) return;

  // Activate the target tab
  const tabId = targetTab.id === 'tab-timeline' ? 'timeline' : 'graph';
  activateTab(tabId);
}

// ---------------------------------------------------------------------------
// initMemoryPage — wire up event listeners after the shell HTML is mounted
// Called by main.ts after inserting renderMemoryPage() into the DOM.
// ---------------------------------------------------------------------------

/**
 * Wires all event listeners for the memory page:
 * - Tab click handlers
 * - Tab keyboard navigation (Arrow keys, Home, End)
 * - Filter change handlers (Requirement 2.2)
 *
 * Safe to call multiple times — removes previous listeners before re-adding.
 *
 * Requirements: 2.1, 2.2, 3.1
 */
export function initMemoryPage(): void {
  const timelineTab = document.getElementById('tab-timeline');
  const graphTab = document.getElementById('tab-graph');

  if (!timelineTab || !graphTab) return;

  // ── Tab click handlers ───────────────────────────────────────────────────
  timelineTab.addEventListener('click', () => {
    activateTab('timeline');
  });

  graphTab.addEventListener('click', () => {
    activateTab('graph');
  });

  // ── Tab keyboard navigation (Arrow keys, Home, End) ──────────────────────
  const tablist = timelineTab.closest('[role="tablist"]');
  if (tablist) {
    tablist.addEventListener('keydown', handleTabKeydown);
  }

  // ── Filter change handlers (Requirement 2.2) ─────────────────────────────
  const workspaceSelect = document.getElementById('memory-workspace-filter') as HTMLSelectElement | null;
  const chainSelect = document.getElementById('memory-chain-filter') as HTMLSelectElement | null;
  const agentSelect = document.getElementById('memory-agent-filter') as HTMLSelectElement | null;

  if (workspaceSelect) {
    workspaceSelect.addEventListener('change', () => {
      handleWorkspaceFilterChange(workspaceSelect.value);
    });
  }

  if (chainSelect) {
    chainSelect.addEventListener('change', () => {
      handleChainFilterChange(chainSelect.value);
    });
  }

  if (agentSelect) {
    agentSelect.addEventListener('change', () => {
      handleAgentFilterChange(agentSelect.value);
    });
  }

  // ── Search input handler (Requirement 2.3) ───────────────────────────────
  const searchInput = document.getElementById('memory-search-input') as HTMLInputElement | null;
  
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      handleSearchInput(searchInput.value);
    });
  }

  // ── Populate filter dropdowns ────────────────────────────────────────────
  populateFilters();

  // ── Initial state ────────────────────────────────────────────────────────
  // Ensure the default tab (timeline) is correctly activated
  activateTab('timeline');

  // Initialize memory state if not present
  const state = getState();
  if (!state.memory) {
    setState({
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
  }
}
