// state.ts — AppState singleton, setState, subscribe
// Feature: monitor-dashboard-redesign
// Implements Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6

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
  summariseStatus: {},
  hiddenChains: {},
  currentPage: 'dashboard',
  drawerChainId: null,
  commitState: null,
  toasts: [],
};

// ---------------------------------------------------------------------------
// localStorage persistence helpers
// ---------------------------------------------------------------------------

const HIDDEN_CHAINS_KEY = 'sw-monitor-hidden-chains';

function loadHiddenChains(): Record<string, boolean> {
  const raw = localStorage.getItem(HIDDEN_CHAINS_KEY);
  if (raw === null || raw === undefined) return {};
  try {
    return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Internal mutable state + subscriber registry
// ---------------------------------------------------------------------------

let _state: AppState = { ...defaultState, hiddenChains: loadHiddenChains() };

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
 */
export function setState(patch: Partial<AppState>): void {
  _state = { ..._state, ...patch };
  if ('hiddenChains' in patch) {
    localStorage.setItem(HIDDEN_CHAINS_KEY, JSON.stringify(_state.hiddenChains));
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
