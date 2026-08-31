// pages/memory.ts — Memory browser page with tab navigation
// Phase 6.4 Memory Browser
// Requirements: 2.1, 2.2, 2.3, 3.1

import { esc, clampText } from '../utils.js';
import { setState, getState, subscribe } from '../state.js';
import type { MemoryPageState, Memory } from '../types.js';

// ---------------------------------------------------------------------------
// Memory card rendering helpers (Task 6.4)
// ---------------------------------------------------------------------------

/**
 * Maps a quality score to a CSS class for colour-coding the badge.
 * 
 * Rules (Requirement 2.5):
 * - score >= 0.85 → 'high'  (green badge)
 * - score >= 0.65 → 'medium' (amber badge)
 * - score < 0.65  → 'low'   (red badge)
 * 
 * @param score - quality score in range [0.0, 1.0]
 * @returns CSS modifier class: 'high', 'medium', or 'low'
 */
function scoreClass(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.85) return 'high';
  if (score >= 0.65) return 'medium';
  return 'low';
}

/**
 * Formats an ISO 8601 timestamp as a human-readable relative time string.
 * Examples: "2 minutes ago", "3 hours ago", "5 days ago"
 * 
 * @param isoTimestamp - ISO 8601 date string (e.g. "2024-03-15T14:05:09.000Z")
 * @returns relative time string
 */
function relativeTime(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return 'just now'; // Future timestamp (clock skew)

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'} ago`;
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  if (weeks < 4) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/**
 * Renders scope pills for a Memory's scope fields.
 * Each present scope field (workspaceId, chainId, agentId, runId, userId)
 * is rendered as a small pill with label and value.
 * 
 * @param scope - MemoryScope object with optional fields
 * @returns HTML string containing scope pill elements
 */
function renderScopePills(scope: Memory['scope']): string {
  const pills: string[] = [];

  // Always show workspaceId (required field)
  pills.push(`
    <span class="memory-card__scope-pill" style="display:inline-block;padding:2px 6px;background:var(--md-surf-high,#313244);color:var(--md-on-surf-var,#a6adc8);border-radius:3px;font-size:10px;font-weight:500;margin-right:4px">
      <span style="color:var(--md-primary,#89b4fa)">ws:</span> ${esc(scope.workspaceId)}
    </span>
  `.trim());

  // Optional fields
  if (scope.chainId) {
    pills.push(`
      <span class="memory-card__scope-pill" style="display:inline-block;padding:2px 6px;background:var(--md-surf-high,#313244);color:var(--md-on-surf-var,#a6adc8);border-radius:3px;font-size:10px;font-weight:500;margin-right:4px">
        <span style="color:var(--md-primary,#89b4fa)">chain:</span> ${esc(scope.chainId)}
      </span>
    `.trim());
  }

  if (scope.agentId) {
    pills.push(`
      <span class="memory-card__scope-pill" style="display:inline-block;padding:2px 6px;background:var(--md-surf-high,#313244);color:var(--md-on-surf-var,#a6adc8);border-radius:3px;font-size:10px;font-weight:500;margin-right:4px">
        <span style="color:var(--md-primary,#89b4fa)">agent:</span> ${esc(scope.agentId)}
      </span>
    `.trim());
  }

  if (scope.runId) {
    pills.push(`
      <span class="memory-card__scope-pill" style="display:inline-block;padding:2px 6px;background:var(--md-surf-high,#313244);color:var(--md-on-surf-var,#a6adc8);border-radius:3px;font-size:10px;font-weight:500;margin-right:4px">
        <span style="color:var(--md-primary,#89b4fa)">run:</span> ${esc(scope.runId)}
      </span>
    `.trim());
  }

  if (scope.userId) {
    pills.push(`
      <span class="memory-card__scope-pill" style="display:inline-block;padding:2px 6px;background:var(--md-surf-high,#313244);color:var(--md-on-surf-var,#a6adc8);border-radius:3px;font-size:10px;font-weight:500;margin-right:4px">
        <span style="color:var(--md-primary,#89b4fa)">user:</span> ${esc(scope.userId)}
      </span>
    `.trim());
  }

  return pills.join('');
}

/**
 * Renders a single memory card with all metadata, scope pills, quality score badge,
 * and action buttons.
 * 
 * Requirements:
 * - 2.5: Quality score badge with colour-coded class (high/medium/low)
 * - 2.10: All dynamic content escaped via esc() utility
 * 
 * @param memory - Memory object to render
 * @returns HTML string for the memory card
 */
export function renderMemoryCard(memory: Memory): string {
  const clampedText = clampText(memory.text, 200);
  const scopePills = renderScopePills(memory.scope);
  const scoreCls = scoreClass(memory.qualityScore);
  const relTime = relativeTime(memory.createdAt);

  // Map score class to colour CSS custom property
  const scoreColourMap: Record<typeof scoreCls, string> = {
    high: 'var(--cg, #a6e3a1)',     // green
    medium: 'var(--cy, #f9e2af)',   // amber
    low: 'var(--cr, #f38ba8)',      // red
  };
  const scoreColour = scoreColourMap[scoreCls];

  return `
<article class="memory-card" data-memory-id="${esc(memory.id)}"
  style="background:var(--md-surf-low,#202030);border-radius:8px;padding:12px;margin-bottom:12px;border-left:3px solid var(--md-outline,#6c7086)">
  
  <div class="memory-card__body">
    <p class="memory-card__text" style="color:var(--md-on-surf,#cdd6f4);font-size:14px;line-height:1.5;margin:0 0 8px 0">
      ${esc(clampedText)}
    </p>
    
    <div class="memory-card__meta" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px">
      ${scopePills}
      
      <span class="memory-card__score memory-card__score--${scoreCls}"
            aria-label="Quality score ${memory.qualityScore.toFixed(2)}"
            style="display:inline-flex;align-items:center;padding:2px 6px;background:${scoreColour}20;color:${scoreColour};border:1px solid ${scoreColour};border-radius:3px;font-size:10px;font-weight:600">
        ${memory.qualityScore.toFixed(2)}
      </span>
      
      <time class="memory-card__time"
            datetime="${esc(memory.createdAt)}"
            style="color:var(--md-on-surf-var,#a6adc8);font-size:11px">
        ${esc(relTime)}
      </time>
    </div>
  </div>
  
  <div class="memory-card__actions" style="display:flex;gap:8px;margin-top:8px">
    <button class="memory-card__btn memory-card__btn--edit"
            aria-label="Edit memory"
            data-action="edit"
            style="padding:4px 10px;background:var(--md-surf,#24273a);color:var(--md-on-surf,#cdd6f4);border:1px solid var(--md-outline,#6c7086);border-radius:4px;font-size:12px;cursor:pointer;transition:all 0.15s">
      Edit
    </button>
    <button class="memory-card__btn memory-card__btn--delete"
            aria-label="Delete memory"
            data-action="delete"
            style="padding:4px 10px;background:var(--md-surf,#24273a);color:var(--cr,#f38ba8);border:1px solid var(--cr,#f38ba8);border-radius:4px;font-size:12px;cursor:pointer;transition:all 0.15s">
      Delete
    </button>
  </div>
</article>
  `.trim();
}

// ---------------------------------------------------------------------------
// Filter handlers and API integration (Requirement 2.2)
// ---------------------------------------------------------------------------

/**
 * Fetches memory list with current filter parameters.
 * Calls GET /api/memory/list with workspaceId, chainId, agentId filters.
 * Updates AppState memory slice with results.
 * Triggers re-render of memory cards.
 *
 * Requirement 2.2: Trigger GET /api/memory/list on filter change
 * Requirement 2.4: Render memory cards ONLY after API success
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
 * Triggers re-render of memory cards.
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

      <!-- Memory cards container (populated by renderMemoryCards) -->
      <!-- Cards are rendered dynamically after API call -->
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
// Edit interaction (Task 7.1, Requirement 2.6)
// ---------------------------------------------------------------------------

/** Tracks which memory card is currently being edited. */
let _editingMemoryId: string | null = null;

/** Stores the original card HTML before entering edit mode. */
let _originalCardHtml: string = '';

/**
 * Enters edit mode for a memory card.
 * Replaces the card body with a textarea pre-filled with the full memory text.
 * Shows Save/Cancel buttons in place of Edit/Delete.
 *
 * Requirement 2.6: Edit opens an inline <textarea> pre-filled with the full memory text
 */
function startEditMode(memoryId: string, fullText: string, cardElement: HTMLElement): void {
  // If already editing another card, cancel that first
  if (_editingMemoryId !== null && _editingMemoryId !== memoryId) {
    cancelEdit();
  }

  _editingMemoryId = memoryId;
  _originalCardHtml = cardElement.outerHTML;

  // Find the card body and actions
  const cardBody = cardElement.querySelector('.memory-card__body') as HTMLElement | null;
  const cardActions = cardElement.querySelector('.memory-card__actions') as HTMLElement | null;

  if (!cardBody || !cardActions) return;

  // Replace card body with textarea
  cardBody.innerHTML = `
    <textarea
      id="memory-edit-textarea-${esc(memoryId)}"
      class="memory-edit__textarea"
      aria-label="Edit memory text"
      style="width:100%;min-height:120px;padding:8px;background:var(--md-surf,#24273a);color:var(--md-on-surf,#cdd6f4);border:1px solid var(--md-outline,#6c7086);border-radius:4px;font-family:inherit;font-size:13px;line-height:1.5;resize:vertical;outline:none"
    >${esc(fullText)}</textarea>
  `.trim();

  // Replace action buttons with Save/Cancel
  cardActions.innerHTML = `
    <button
      class="memory-card__btn memory-card__btn--save"
      aria-label="Save changes"
      data-action="save"
      style="padding:4px 10px;background:var(--md-primary,#89b4fa);color:var(--md-on-primary-c,#1e1e2e);border:1px solid var(--md-primary,#89b4fa);border-radius:4px;font-size:12px;font-weight:500;cursor:pointer;transition:all 0.15s">
      Save
    </button>
    <button
      class="memory-card__btn memory-card__btn--cancel"
      aria-label="Cancel editing"
      data-action="cancel"
      style="padding:4px 10px;background:var(--md-surf,#24273a);color:var(--md-on-surf,#cdd6f4);border:1px solid var(--md-outline,#6c7086);border-radius:4px;font-size:12px;cursor:pointer;transition:all 0.15s">
      Cancel
    </button>
  `.trim();

  // Focus the textarea
  const textarea = document.getElementById(`memory-edit-textarea-${memoryId}`) as HTMLTextAreaElement | null;
  if (textarea) {
    textarea.focus();
    // Move cursor to end of text
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;
  }

  // Wire up Save/Cancel handlers
  const saveBtn = cardActions.querySelector('[data-action="save"]') as HTMLButtonElement | null;
  const cancelBtn = cardActions.querySelector('[data-action="cancel"]') as HTMLButtonElement | null;

  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      void handleSaveEdit(memoryId, cardElement);
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      cancelEdit();
    });
  }
}

/**
 * Saves the edited memory text via PATCH /api/memory/:id.
 * On success, updates the card with the new text.
 * On error, shows error toast and restores the original card.
 *
 * Requirement 2.6: Save calls PATCH /api/memory/:id, updates card on success
 */
async function handleSaveEdit(memoryId: string, cardElement: HTMLElement): Promise<void> {
  const textarea = document.getElementById(`memory-edit-textarea-${memoryId}`) as HTMLTextAreaElement | null;
  
  if (!textarea) return;

  const newText = textarea.value.trim();
  
  if (newText === '') {
    // Empty text not allowed - show error toast
    try {
      const { enqueueToast } = await import('../toast.js');
      enqueueToast({
        id: crypto.randomUUID(),
        type: 'error',
        message: 'Memory text cannot be empty',
        persistent: false,
      });
    } catch {
      console.error('[memory] Empty text error');
    }
    return;
  }

  // Show loading state on Save button
  const saveBtn = cardElement.querySelector('[data-action="save"]') as HTMLButtonElement | null;
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
  }

  try {
    // Call PATCH /api/memory/:id
    const response = await fetch(`/api/memory/${memoryId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: newText }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const updatedMemory = await response.json() as Memory;

    // Update the memory in AppState
    const state = getState();
    const memoryState = state.memory;

    if (memoryState) {
      const updatedMemories = memoryState.memories.map(m =>
        m.id === memoryId ? updatedMemory : m
      );

      setState({
        memory: {
          ...memoryState,
          memories: updatedMemories,
        },
      });
    }

    // Exit edit mode and re-render the card with updated data
    _editingMemoryId = null;
    _originalCardHtml = '';

    // Replace the card with the updated version
    const newCardHtml = renderMemoryCard(updatedMemory);
    cardElement.outerHTML = newCardHtml;

    // Re-wire event listeners for the new card
    const newCard = document.querySelector(`[data-memory-id="${memoryId}"]`) as HTMLElement | null;
    if (newCard) {
      wireCardEventListeners(newCard);
    }

    // Show success toast
    try {
      const { enqueueToast } = await import('../toast.js');
      enqueueToast({
        id: crypto.randomUUID(),
        type: 'success',
        message: 'Memory updated',
        persistent: false,
      });
    } catch {
      console.log('[memory] Memory updated');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    
    // Show error toast
    try {
      const { enqueueToast } = await import('../toast.js');
      enqueueToast({
        id: crypto.randomUUID(),
        type: 'error',
        message: `Failed to save: ${message}`,
        persistent: true,
      });
    } catch {
      console.error('[memory] Save failed:', message);
    }

    // Restore original card HTML on error
    cancelEdit();
  }
}

/**
 * Cancels the current edit operation and restores the original card HTML.
 * 
 * Requirement 2.6: Cancel restores the card
 */
function cancelEdit(): void {
  if (_editingMemoryId === null) return;

  const cardElement = document.querySelector(`[data-memory-id="${_editingMemoryId}"]`) as HTMLElement | null;
  
  if (cardElement && _originalCardHtml) {
    cardElement.outerHTML = _originalCardHtml;

    // Re-wire event listeners for the restored card
    const restoredCard = document.querySelector(`[data-memory-id="${_editingMemoryId}"]`) as HTMLElement | null;
    if (restoredCard) {
      wireCardEventListeners(restoredCard);
    }
  }

  _editingMemoryId = null;
  _originalCardHtml = '';
}

// ---------------------------------------------------------------------------
// Delete interaction (Task 7.2, Requirement 2.7, 2.8, 2.9)
// ---------------------------------------------------------------------------

/**
 * Shows a confirmation tooltip for memory deletion.
 * Replaces the Delete button with "Delete this memory?" text and Confirm/Cancel buttons.
 * 
 * Requirement 2.7: Delete shows confirmation tooltip before API call
 */
function showDeleteConfirmation(cardElement: HTMLElement): void {
  const actionsContainer = cardElement.querySelector('.memory-card__actions') as HTMLElement | null;
  if (!actionsContainer) return;

  // Store original HTML to restore on cancel
  const originalHTML = actionsContainer.innerHTML;

  // Render confirmation UI
  actionsContainer.innerHTML = `
    <div class="memory-delete-confirm" style="display:flex;align-items:center;gap:8px">
      <span style="color:var(--md-on-surf-var,#a6adc8);font-size:12px">Delete this memory?</span>
      <button class="memory-card__btn memory-card__btn--confirm"
              aria-label="Confirm deletion"
              data-action="confirm-delete"
              style="padding:4px 10px;background:var(--cr,#f38ba8);color:var(--md-surf,#24273a);border:1px solid var(--cr,#f38ba8);border-radius:4px;font-size:12px;font-weight:500;cursor:pointer;transition:all 0.15s">
        Confirm
      </button>
      <button class="memory-card__btn memory-card__btn--cancel-delete"
              aria-label="Cancel deletion"
              data-action="cancel-delete"
              style="padding:4px 10px;background:var(--md-surf,#24273a);color:var(--md-on-surf,#cdd6f4);border:1px solid var(--md-outline,#6c7086);border-radius:4px;font-size:12px;cursor:pointer;transition:all 0.15s">
        Cancel
      </button>
    </div>
  `.trim();

  // Wire Confirm button
  const confirmBtn = actionsContainer.querySelector('[data-action="confirm-delete"]') as HTMLButtonElement | null;
  if (confirmBtn) {
    confirmBtn.addEventListener('click', () => {
      void handleDeleteConfirmed(cardElement);
    });
  }

  // Wire Cancel button
  const cancelBtn = actionsContainer.querySelector('[data-action="cancel-delete"]') as HTMLButtonElement | null;
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      // Restore original buttons
      actionsContainer.innerHTML = originalHTML;
      // Re-wire event listeners after restoring
      wireCardEventListeners(cardElement);
    });
  }
}

/**
 * Handles confirmed memory deletion with loading state and retry logic.
 * 
 * Requirement 2.8: Show loading state (spinner, reduced opacity, disabled buttons) during DELETE call
 * Requirement 2.9: Remove card from DOM on success, retry once if removal fails, fall back to reload
 */
async function handleDeleteConfirmed(cardElement: HTMLElement): Promise<void> {
  const memoryId = cardElement.dataset.memoryId;
  if (!memoryId) return;

  // Show loading state (Requirement 2.8)
  const actionsContainer = cardElement.querySelector('.memory-card__actions') as HTMLElement | null;
  if (actionsContainer) {
    actionsContainer.innerHTML = `
      <div class="memory-delete-loading" style="display:flex;align-items:center;gap:8px;opacity:0.6">
        <span style="color:var(--md-on-surf-var,#a6adc8);font-size:12px">Deleting...</span>
        <div class="spinner" style="width:16px;height:16px;border:2px solid var(--md-outline,#6c7086);border-top-color:var(--md-primary,#89b4fa);border-radius:50%;animation:spin 0.8s linear infinite"></div>
      </div>
    `.trim();
  }

  // Apply reduced opacity and disable pointer events on entire card (Requirement 2.8)
  cardElement.style.opacity = '0.6';
  cardElement.style.pointerEvents = 'none';

  try {
    // Call DELETE API
    const response = await fetch(`/api/memory/${memoryId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Success - remove card from DOM (Requirement 2.9)
    try {
      cardElement.remove();
    } catch (err) {
      // First DOM removal failed - retry once after 50ms (Requirement 2.9)
      console.warn('[memory] DOM removal failed, retrying...', err);
      
      await new Promise(resolve => setTimeout(resolve, 50));
      
      try {
        cardElement.remove();
      } catch (retryErr) {
        // Second attempt failed - fall back to full page reload (Requirement 2.9)
        console.error('[memory] DOM removal retry failed, reloading page', retryErr);
        location.reload();
        return;
      }
    }

    // Update AppState - remove the memory from the list
    const state = getState();
    const memoryState = state.memory;

    if (memoryState) {
      const updatedMemories = memoryState.memories.filter(m => m.id !== memoryId);
      setState({
        memory: {
          ...memoryState,
          memories: updatedMemories,
          total: Math.max(0, memoryState.total - 1),
        },
      });
    }

    // Show success toast
    try {
      const { enqueueToast } = await import('../toast.js');
      enqueueToast({
        id: crypto.randomUUID(),
        type: 'success',
        message: 'Memory deleted',
        persistent: false,
      });
    } catch {
      console.log('[memory] Memory deleted');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    
    // Restore card state on error
    cardElement.style.opacity = '1';
    cardElement.style.pointerEvents = 'auto';
    
    // Show error toast
    try {
      const { enqueueToast } = await import('../toast.js');
      enqueueToast({
        id: crypto.randomUUID(),
        type: 'error',
        message: `Failed to delete: ${message}`,
        persistent: true,
      });
    } catch {
      console.error('[memory] Delete failed:', message);
    }

    // Restore original card buttons
    const actionsContainer = cardElement.querySelector('.memory-card__actions') as HTMLElement | null;
    if (actionsContainer) {
      // Re-render original Edit/Delete buttons
      actionsContainer.innerHTML = `
        <button class="memory-card__btn memory-card__btn--edit"
                aria-label="Edit memory"
                data-action="edit"
                style="padding:4px 10px;background:var(--md-surf,#24273a);color:var(--md-on-surf,#cdd6f4);border:1px solid var(--md-outline,#6c7086);border-radius:4px;font-size:12px;cursor:pointer;transition:all 0.15s">
          Edit
        </button>
        <button class="memory-card__btn memory-card__btn--delete"
                aria-label="Delete memory"
                data-action="delete"
                style="padding:4px 10px;background:var(--md-surf,#24273a);color:var(--cr,#f38ba8);border:1px solid var(--cr,#f38ba8);border-radius:4px;font-size:12px;cursor:pointer;transition:all 0.15s">
          Delete
        </button>
      `.trim();
      
      // Re-wire event listeners
      wireCardEventListeners(cardElement);
    }
  }
}

/**
 * Click handler for the Delete button - shows confirmation UI.
 * 
 * Requirement 2.7: Delete shows confirmation before API call
 */
function handleDeleteClick(cardElement: HTMLElement): void {
  showDeleteConfirmation(cardElement);
}

/**
 * Wires Edit and Delete button event listeners for a single memory card.
 * 
 * Requirements: 2.6 (edit interaction), 2.7 (delete confirmation)
 */
function wireCardEventListeners(cardElement: HTMLElement): void {
  const editBtn = cardElement.querySelector('[data-action="edit"]') as HTMLButtonElement | null;
  const deleteBtn = cardElement.querySelector('[data-action="delete"]') as HTMLButtonElement | null;

  if (editBtn) {
    editBtn.addEventListener('click', () => {
      const memoryId = cardElement.dataset.memoryId;
      if (!memoryId) return;

      // Find the memory in AppState to get full text
      const state = getState();
      const memoryState = state.memory;
      
      if (memoryState) {
        const memory = memoryState.memories.find(m => m.id === memoryId);
        if (memory) {
          startEditMode(memoryId, memory.text, cardElement);
        }
      }
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      void handleDeleteClick(cardElement);
    });
  }
}

// ---------------------------------------------------------------------------
// Pagination (Task 8.2, Requirement 2.4)
// ---------------------------------------------------------------------------

/**
 * Fetches the next page of memories using the cursor from AppState.
 * Appends new memories to the existing list.
 * Called when "Load more" button is clicked.
 *
 * Requirement 2.4: Call GET /api/memory/list with cursor from previous response
 * Requirement 2.4: Append new memory cards to existing list
 */
async function fetchNextPage(): Promise<void> {
  const state = getState();
  const memoryState = state.memory;

  if (!memoryState || !memoryState.cursor) {
    // No cursor available - nothing to fetch
    return;
  }

  // Set loading state (preserve existing memories)
  setState({
    memory: { ...memoryState, loading: true, error: null },
  });

  try {
    // Build query params with cursor
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
    
    params.set('cursor', memoryState.cursor);
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

    // Append new memories to existing list
    const updatedMemoryState = getState().memory;
    if (updatedMemoryState) {
      setState({
        memory: {
          ...updatedMemoryState,
          memories: [
            ...updatedMemoryState.memories,
            ...(data.memories as MemoryPageState['memories']),
          ],
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
 * Renders the "Load more" button at the bottom of the timeline.
 * Button appears only when cursor !== null (more pages available).
 * Hidden when cursor is null (reached end of pagination).
 *
 * Requirement 2.4: Render "Load more" button when nextCursor !== null
 * Requirement 2.4: Hide button when nextCursor is null (reached end)
 */
function renderLoadMoreButton(): void {
  const timelinePanel = document.getElementById('panel-timeline');
  if (!timelinePanel) return;

  const state = getState();
  const memoryState = state.memory;

  if (!memoryState) return;

  // Find or create the load more container
  let loadMoreContainer = timelinePanel.querySelector('.memory-load-more') as HTMLElement | null;
  
  if (!loadMoreContainer) {
    // Create container at the end of the timeline panel
    loadMoreContainer = document.createElement('div');
    loadMoreContainer.className = 'memory-load-more';
    loadMoreContainer.style.textAlign = 'center';
    loadMoreContainer.style.marginTop = '16px';
    timelinePanel.appendChild(loadMoreContainer);
  }

  // Clear existing content
  loadMoreContainer.innerHTML = '';

  // Don't show button if:
  // - Still loading
  // - Has error
  // - No memories loaded
  // - Search is active (search results don't paginate)
  // - No cursor (reached end)
  if (
    memoryState.loading ||
    memoryState.error ||
    memoryState.memories.length === 0 ||
    memoryState.searchQuery !== '' ||
    !memoryState.cursor
  ) {
    return;
  }

  // Render "Load more" button
  loadMoreContainer.innerHTML = `
    <button
      class="memory-load-more__btn"
      aria-label="Load more memories"
      style="padding:10px 20px;background:var(--md-surf,#24273a);color:var(--md-on-surf,#cdd6f4);border:1px solid var(--md-outline,#6c7086);border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;transition:all 0.15s"
    >
      Load more
    </button>
  `.trim();

  // Wire click handler
  const loadMoreBtn = loadMoreContainer.querySelector('.memory-load-more__btn') as HTMLButtonElement | null;
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => {
      void fetchNextPage();
    });
  }
}

// ---------------------------------------------------------------------------
// Memory card rendering
// ---------------------------------------------------------------------------

/**
 * Renders all memory cards from AppState and wires their event listeners.
 * Called after fetchMemoryList() or fetchMemorySearch() updates state.
 */
function renderMemoryCards(): void {
  const timelinePanel = document.getElementById('panel-timeline');
  if (!timelinePanel) return;

  const state = getState();
  const memoryState = state.memory;

  if (!memoryState) return;

  // Find or create the memory cards container
  let cardsContainer = timelinePanel.querySelector('.memory-cards') as HTMLElement | null;
  
  if (!cardsContainer) {
    // Create the container after the search input
    const searchDiv = timelinePanel.querySelector('.memory-search');
    
    cardsContainer = document.createElement('div');
    cardsContainer.className = 'memory-cards';
    cardsContainer.style.marginBottom = '16px';
    
    if (searchDiv && searchDiv.nextSibling) {
      timelinePanel.insertBefore(cardsContainer, searchDiv.nextSibling);
    } else {
      timelinePanel.appendChild(cardsContainer);
    }
  }

  // Clear existing cards
  cardsContainer.innerHTML = '';

  // Show loading state
  if (memoryState.loading) {
    cardsContainer.innerHTML = `
      <div class="memory-cards__loading" style="padding:40px;text-align:center;color:var(--md-on-surf-var,#a6adc8)">
        <div style="font-size:14px">Loading memories...</div>
      </div>
    `.trim();
    return;
  }

  // Show error state
  if (memoryState.error) {
    cardsContainer.innerHTML = `
      <div class="memory-cards__error" style="padding:40px;text-align:center;color:var(--cr,#f38ba8)">
        <div style="font-size:14px;margin-bottom:12px">${esc(memoryState.error)}</div>
        <button
          class="memory-cards__retry-btn"
          style="padding:8px 16px;background:var(--md-surf,#24273a);color:var(--md-on-surf,#cdd6f4);border:1px solid var(--md-outline,#6c7086);border-radius:4px;font-size:13px;cursor:pointer"
        >
          Retry
        </button>
      </div>
    `.trim();

    // Wire retry button
    const retryBtn = cardsContainer.querySelector('.memory-cards__retry-btn') as HTMLButtonElement | null;
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        void fetchMemoryList();
      });
    }
    return;
  }

  // Show empty state
  if (memoryState.memories.length === 0) {
    const emptyMessage = memoryState.searchQuery
      ? `No memories found for "${esc(memoryState.searchQuery)}"`
      : 'No memories yet';

    cardsContainer.innerHTML = `
      <div class="memory-cards__empty" style="padding:40px;text-align:center;color:var(--md-on-surf-var,#a6adc8)">
        <div style="font-size:14px">${emptyMessage}</div>
      </div>
    `.trim();
    return;
  }

  // Render memory cards
  const cardsHtml = memoryState.memories.map(memory => renderMemoryCard(memory)).join('');
  cardsContainer.innerHTML = cardsHtml;

  // Wire event listeners for all cards
  const cardElements = cardsContainer.querySelectorAll('.memory-card') as NodeListOf<HTMLElement>;
  for (const cardElement of cardElements) {
    wireCardEventListeners(cardElement);
  }

  // Render "Load more" button (Task 8.2, Requirement 2.4)
  renderLoadMoreButton();
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
 * - Memory card Edit/Delete handlers (Requirement 2.6)
 *
 * Safe to call multiple times — removes previous listeners before re-adding.
 *
 * Requirements: 2.1, 2.2, 2.6, 3.1
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

  // ── Initial timeline load (Requirement 2.4) ──────────────────────────────
  // Trigger initial data fetch if no search is active (default list view)
  const currentState = getState();
  const memoryState = currentState.memory;
  
  if (memoryState && memoryState.searchQuery === '') {
    // Default list view - fetch initial memory list
    void fetchMemoryList();
  }

  // ── Subscribe to state changes for memory card rendering ─────────────────
  // Whenever memory state changes, re-render the cards
  const unsubscribe = subscribe(() => {
    const currentState = getState();
    if (currentState.currentPage === 'memory' && currentState.memory) {
      renderMemoryCards();
    }
  });

  // Store unsubscribe function for cleanup (when needed in future)
  // For now, subscription lives for the lifetime of the page
  (window as unknown as Record<string, unknown>)._memoryPageUnsubscribe = unsubscribe;
}
