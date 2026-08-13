// state.ts — AppState singleton, setState, subscribe
// Feature: monitor-dashboard-redesign
// Implements Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
// Also implements Requirements 6.8, 6.9, 6.10, 6.11 (workspace filter persistence)

import type {
  AppState,
  Chain,
  JobChain,
  Job,
  PollLogEntry,
  SystemStatus,
  GitStatus,
  Page,
  CommitState,
  Toast,
  WorkspaceFilterState,
  BuildQueueRecord,
  AnalyticsState,
} from './types';

// ---------------------------------------------------------------------------
// Default state (all fields required by AppState interface)
// ---------------------------------------------------------------------------

const defaultState: AppState = {
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
  currentPage: 'dashboard',
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
};

// ---------------------------------------------------------------------------
// localStorage persistence helpers
// ---------------------------------------------------------------------------

const HIDDEN_CHAINS_KEY = 'sw-monitor-hidden-chains';
const SELECTED_WORKSPACE_KEY = 'selectedWorkspaceId';

function loadHiddenChains(): Record<string, boolean> {
  const raw = localStorage.getItem(HIDDEN_CHAINS_KEY);
  if (raw === null || raw === undefined) return {};
  try {
    return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    return {};
  }
}

/**
 * Reads the persisted workspace ID from localStorage.
 * Returns null (meaning "All Workspaces") when nothing is stored or the
 * value cannot be read.
 *
 * Requirement 6.11: restore last selected workspace filter on page load.
 */
function loadSelectedWorkspaceId(): string | null {
  try {
    return localStorage.getItem(SELECTED_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

/**
 * Persists the workspace selection to localStorage.
 * If localStorage.setItem() throws (e.g. storage quota exceeded or
 * private-browsing restrictions), logs a warning and continues.
 *
 * Requirement 6.8: handle localStorage.setItem failures gracefully.
 * Requirement 6.9: persist selection with key "selectedWorkspaceId".
 */
function persistSelectedWorkspaceId(workspaceId: string | null): void {
  try {
    if (workspaceId === null) {
      localStorage.removeItem(SELECTED_WORKSPACE_KEY);
    } else {
      localStorage.setItem(SELECTED_WORKSPACE_KEY, workspaceId);
    }
  } catch (err) {
    console.warn('[workspace-filter] Failed to persist workspace selection to localStorage:', err);
  }
}

/**
 * Validates a restored workspace ID against the list of configured workspaces.
 * Returns null ("All Workspaces") when the stored ID is not found.
 *
 * Requirement 6.10: default to "All Workspaces" if restored ID doesn't match.
 */
function resolveRestoredWorkspaceId(
  storedId: string | null,
  availableWorkspaces: { id: string; displayName: string }[],
): string | null {
  if (storedId === null) return null;
  const found = availableWorkspaces.some((w) => w.id === storedId);
  return found ? storedId : null;
}

// ---------------------------------------------------------------------------
// Internal mutable state + subscriber registry
// ---------------------------------------------------------------------------

let _state: AppState = {
  ...defaultState,
  hiddenChains: loadHiddenChains(),
  workspaceFilter: {
    selectedWorkspaceId: loadSelectedWorkspaceId(),
    availableWorkspaces: [],
  },
};

const _subscribers: Set<() => void> = new Set();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a shallow copy of the current AppState.
 * Callers receive a snapshot; they cannot mutate the store directly.
 */
export function getState(): AppState {
  return { ..._state };
}

/**
 * Performs a shallow merge of `patch` into AppState, then synchronously
 * calls every registered subscriber exactly once.
 *
 * Requirements 3.2, 3.6:
 *   - Top-level keys present in patch replace the corresponding keys.
 *   - Top-level keys absent from patch retain their previous values.
 *   - Two consecutive non-overlapping patches both take full effect.
 *
 * Requirement 6.9 / 6.10 / 6.11:
 *   - When workspaceFilter is patched:
 *     - The selectedWorkspaceId is validated against availableWorkspaces.
 *     - An ID that no longer exists in availableWorkspaces is reset to null.
 *     - The resolved selection is persisted to localStorage.
 */
export function setState(patch: Partial<AppState>): void {
  _state = { ..._state, ...patch };

  if ('hiddenChains' in patch) {
    localStorage.setItem(HIDDEN_CHAINS_KEY, JSON.stringify(_state.hiddenChains));
  }

  if ('workspaceFilter' in patch) {
    // Validate the restored/new selection against available workspaces.
    // This covers Requirement 6.10: if the stored ID is no longer present
    // in the configured workspace list, fall back to null ("All Workspaces").
    const resolved = resolveRestoredWorkspaceId(
      _state.workspaceFilter.selectedWorkspaceId,
      _state.workspaceFilter.availableWorkspaces,
    );
    if (resolved !== _state.workspaceFilter.selectedWorkspaceId) {
      _state = {
        ..._state,
        workspaceFilter: { ..._state.workspaceFilter, selectedWorkspaceId: resolved },
      };
    }
    // Persist the (validated) selection.
    persistSelectedWorkspaceId(_state.workspaceFilter.selectedWorkspaceId);
  }

  _subscribers.forEach((fn) => fn());
}

/**
 * Registers `fn` as a subscriber; it will be called after every setState.
 * Returns an unsubscribe function that removes `fn` from the registry.
 *
 * Requirement 3.3:
 *   - fn is called after every setState invocation.
 *   - The returned function removes fn so it is no longer called.
 */
export function subscribe(fn: () => void): () => void {
  _subscribers.add(fn);
  return () => {
    _subscribers.delete(fn);
  };
}

// ---------------------------------------------------------------------------
// Convenience helpers for workspace filter
// ---------------------------------------------------------------------------

/**
 * Returns the currently selected workspace ID, or null for "All Workspaces".
 */
export function getSelectedWorkspaceId(): string | null {
  return _state.workspaceFilter.selectedWorkspaceId;
}

/**
 * Sets the selected workspace and persists it.
 * Pass null to select "All Workspaces".
 *
 * Requirements 6.8, 6.9, 6.10.
 */
export function setSelectedWorkspaceId(workspaceId: string | null): void {
  setState({
    workspaceFilter: {
      ..._state.workspaceFilter,
      selectedWorkspaceId: workspaceId,
    },
  });
}

/**
 * Updates the list of available workspaces and re-validates the current
 * selection, defaulting to null if the selection is no longer valid.
 *
 * Call this once workspace configuration is loaded from the API.
 * Requirements 6.10, 6.11.
 */
export function setAvailableWorkspaces(
  workspaces: { id: string; displayName: string }[],
): void {
  setState({
    workspaceFilter: {
      availableWorkspaces: workspaces,
      // Keep the existing selection — setState will validate it against
      // the new available list and fall back to null if needed.
      selectedWorkspaceId: _state.workspaceFilter.selectedWorkspaceId,
    },
  });
}
