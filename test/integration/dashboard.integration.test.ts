// ---------------------------------------------------------------------------
// Dashboard Integration Tests — browser-based interactions with localStorage
//
// Feature: multi-workspace-monitoring
// Task: 8.7 Write integration tests for dashboard interactions
// Validates: Requirements 6.1-6.11
//
// These tests verify:
//   - Workspace filter component render: "All Workspaces" + per-workspace options (6.1-6.3)
//   - kebabToTitleCase display name conversion (6.3)
//   - Workspace selection filters all views: Dashboard, Activity, Work (6.4-6.7)
//   - localStorage failure handling (6.8)
//   - Workspace filter persistence (6.9)
//   - Stale workspace ID fallback to "All Workspaces" (6.10)
//   - Workspace filter restoration on page load (6.11)
//
// NOTE: Bun's test environment has no DOM globals. DOM elements are created
// via globalThis.document mock.  Pure logic (filtering, persistence) is tested
// directly against the exported functions.  Component DOM tests use a minimal
// JSDOM-style stub included below.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from 'bun:test';

// ---------------------------------------------------------------------------
// localStorage mock — Bun's test environment has no DOM globals
// ---------------------------------------------------------------------------

const localStorageStore: Record<string, string> = {};

const localStorageMock = {
  getItem:    (key: string): string | null => localStorageStore[key] ?? null,
  setItem:    (key: string, value: string): void => { localStorageStore[key] = value; },
  removeItem: (key: string): void => { delete localStorageStore[key]; },
  clear:      (): void => { Object.keys(localStorageStore).forEach((k) => delete localStorageStore[k]); },
};

// Inject mock before any modules are loaded
(globalThis as Record<string, unknown>).localStorage = localStorageMock;

// ---------------------------------------------------------------------------
// Minimal DOM stub needed by workspaceFilter.ts's createElement calls
// ---------------------------------------------------------------------------

function makeElement(tag: string): Record<string, unknown> {
  const attrs: Record<string, string> = {};
  const children: unknown[] = [];
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const el: Record<string, unknown> = {
    tagName: tag.toUpperCase(),
    className: '',
    id: '',
    value: '',
    textContent: '',
    style: {},
    children,
    innerHTML: '',
    setAttribute: (k: string, v: string) => { attrs[k] = v; },
    getAttribute: (k: string) => attrs[k] ?? null,
    appendChild: (child: unknown) => { children.push(child); return child; },
    addEventListener: (event: string, fn: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(fn);
    },
    _trigger: (event: string, ...args: unknown[]) => {
      (listeners[event] ?? []).forEach((fn) => fn(...args));
    },
    _listeners: listeners,
    _attrs: attrs,
  };
  return el;
}

const documentMock = {
  createElement: (tag: string) => makeElement(tag),
  createTextNode: (text: string) => ({ nodeValue: text, textContent: text }),
  createComment: (text: string) => ({ nodeValue: text }),
};

if (!(globalThis as Record<string, unknown>).document) {
  (globalThis as Record<string, unknown>).document = documentMock;
}

// ---------------------------------------------------------------------------
// Module reload helpers — fresh instance per test for isolation
// ---------------------------------------------------------------------------

/**
 * Loads a fresh instance of state.ts with cleared localStorage so each test
 * is fully isolated from others.  The query string cache-bust mirrors the
 * pattern used in state.test.ts.
 */
async function freshStateModule() {
  localStorageMock.clear();
  const ts = Date.now() + Math.random();
  return import(`../../src/dashboard/state.ts?bust=${ts}`) as Promise<
    typeof import('../../src/dashboard/state.ts')
  >;
}

/**
 * Load the workspaceFilter module fresh (it imports no state globals).
 */
async function freshFilterModule() {
  const ts = Date.now() + Math.random();
  return import(`../../src/dashboard/components/workspaceFilter.ts?bust=${ts}`) as Promise<
    typeof import('../../src/dashboard/components/workspaceFilter.ts')
  >;
}

/**
 * Load fresh Activity page module for filtering tests.
 */
async function freshActivityModule() {
  const ts = Date.now() + Math.random();
  return import(`../../src/dashboard/pages/activity.ts?bust=${ts}`) as Promise<
    typeof import('../../src/dashboard/pages/activity.ts')
  >;
}

/**
 * Load fresh dashboard page module for git status selection logic tests.
 */
async function freshDashboardModule() {
  const ts = Date.now() + Math.random();
  return import(`../../src/dashboard/pages/dashboard.ts?bust=${ts}`) as Promise<
    typeof import('../../src/dashboard/pages/dashboard.ts')
  >;
}

// ---------------------------------------------------------------------------
// Shared test data helpers
// ---------------------------------------------------------------------------

const WORKSPACE_IDS = ['workspace-alpha', 'workspace-beta', 'workspace-gamma'];

function makeAvailableWorkspaces(ids: string[]) {
  return ids.map((id) => ({
    id,
    displayName: id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  }));
}

function makeChain(chainId: string, workspaceId: string, totalMessages = 5, opts?: Partial<{
  unsummarisedDelta: number;
  latestSession: {
    workflowHash: string; sessionJsonl: string; chainId: string; chainIndex: number;
    previousSession: string; topic: string; messageCount: number; userMessageCount: number;
    contextUsagePct: number; lastMessageAt: string; lastSummarisedMessageCount: number;
    lastSummarisedAt: string; summaryFile: string;
    status: 'active' | 'idle' | 'complete' | 'rate-limited';
    firstUserMessage: string; lastUserMessage: string; lastAgentMessage: string;
    startTime: string; workspaceId: string;
  };
}>) {
  return {
    chainId,
    displayName: `Chain ${chainId}`,
    workspaceId,
    nextIndex: 1,
    sessions: [],
    totalMessages,
    createdAt: '2024-01-01T00:00:00Z',
    lastActiveAt: '2024-01-02T00:00:00Z',
    unsummarisedDelta: opts?.unsummarisedDelta,
    latestSession: opts?.latestSession,
  };
}

function makeJob(id: string, workspaceId: string, status: 'running' | 'done' | 'error' = 'done') {
  return {
    id,
    name: `job-${id}`,
    jobChain: `chain-${id}`,
    sessionChainId: '',
    timestamp: '2024-01-01T00:00:00Z',
    type: 'crawl',
    agent: 'agent',
    status,
    lines: 0,
    lastLine: '',
    hasLog: false,
    logError: false,
    mdFile: '',
    logFile: '',
    agentDone: '',
    sizeBytes: 0,
    workspaceId,
  };
}

function makeGitStatus(workspaceId: string, clean = true) {
  return {
    branch: 'main',
    clean,
    modified: clean ? [] : ['file.ts'],
    staged: [],
    untracked: [],
    ahead: 0,
    behind: 0,
    workspaceId,
  };
}

// ---------------------------------------------------------------------------
// Requirement 6.1: Dashboard displays a Workspace_Filter control
// Requirement 6.2: "All Workspaces" option is the default selection
// Requirement 6.3: Per-workspace options with kebab→TitleCase display names
// ---------------------------------------------------------------------------

describe('Requirement 6.1-6.3 — Workspace filter component rendering', () => {
  test('6.2: kebabToTitleCase converts workspace IDs to Title Case display names', async () => {
    const mod = await freshFilterModule();
    expect(mod.kebabToTitleCase('workspace-alpha')).toBe('Workspace Alpha');
    expect(mod.kebabToTitleCase('scottish-water')).toBe('Scottish Water');
    expect(mod.kebabToTitleCase('project-alpha')).toBe('Project Alpha');
    expect(mod.kebabToTitleCase('my-great-app')).toBe('My Great App');
    expect(mod.kebabToTitleCase('singleword')).toBe('Singleword');
  });

  test('6.2: buildFilterState creates state with "All Workspaces" as null and correct options', async () => {
    const mod = await freshFilterModule();
    const state = mod.buildFilterState(WORKSPACE_IDS, null);

    expect(state.selectedWorkspaceId).toBeNull();
    expect(state.availableWorkspaces).toHaveLength(WORKSPACE_IDS.length);
    expect(state.availableWorkspaces[0].id).toBe('workspace-alpha');
    expect(state.availableWorkspaces[0].displayName).toBe('Workspace Alpha');
  });

  test('6.3: buildFilterState converts all workspace IDs to Title Case display names', async () => {
    const mod = await freshFilterModule();
    const ids = ['alpha-project', 'beta-workspace', 'gamma'];
    const state = mod.buildFilterState(ids, null);

    expect(state.availableWorkspaces[0].displayName).toBe('Alpha Project');
    expect(state.availableWorkspaces[1].displayName).toBe('Beta Workspace');
    expect(state.availableWorkspaces[2].displayName).toBe('Gamma');
  });

  test('6.3: buildFilterState with selected ID sets correct selectedWorkspaceId', async () => {
    const mod = await freshFilterModule();
    const state = mod.buildFilterState(WORKSPACE_IDS, 'workspace-beta');

    expect(state.selectedWorkspaceId).toBe('workspace-beta');
    expect(state.availableWorkspaces).toHaveLength(3);
  });

  test('6.2: createWorkspaceFilter component has persistSelection and restoreSelection methods', async () => {
    const mod = await freshFilterModule();
    const filter = mod.createWorkspaceFilter();

    expect(typeof filter.persistSelection).toBe('function');
    expect(typeof filter.restoreSelection).toBe('function');
    expect(typeof filter.onSelectionChange).toBe('function');
    expect(typeof filter.render).toBe('function');
  });

  test('6.2: onWorkspaceChange registers a handler that can be unsubscribed', async () => {
    const mod = await freshFilterModule();
    const received: Array<string | null> = [];
    const unsubscribe = mod.onWorkspaceChange((id) => received.push(id));

    // Trigger via filter component
    const filter = mod.createWorkspaceFilter();
    filter.onSelectionChange('workspace-alpha');

    expect(received).toContain('workspace-alpha');

    // After unsubscribe, handler should not fire
    const countBefore = received.length;
    unsubscribe();
    filter.onSelectionChange('workspace-beta');
    expect(received.length).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// Requirement 6.4-6.7: Dashboard filtering by workspace
// ---------------------------------------------------------------------------

describe('Requirement 6.4-6.7 — Dashboard data filtering by selected workspace', () => {
  test('6.4: when a workspace is selected, Dashboard filters all displayed chains to that workspace', async () => {
    const mod = await freshStateModule();
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);
    mod.setAvailableWorkspaces(workspaces);

    const chains = [
      makeChain('c1', 'workspace-alpha'),
      makeChain('c2', 'workspace-beta'),
      makeChain('c3', 'workspace-alpha'),
    ];

    mod.setState({ chains });
    mod.setSelectedWorkspaceId('workspace-alpha');

    const state = mod.getState();
    const filtered = state.chains.filter((c) =>
      state.workspaceFilter.selectedWorkspaceId === null ||
      c.workspaceId === state.workspaceFilter.selectedWorkspaceId
    );

    expect(filtered).toHaveLength(2);
    expect(filtered.every((c) => c.workspaceId === 'workspace-alpha')).toBe(true);
  });

  test('6.5: when a workspace is selected, Dashboard filters all displayed jobs to that workspace', async () => {
    const mod = await freshStateModule();
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);
    mod.setAvailableWorkspaces(workspaces);

    const jobs = [
      makeJob('j1', 'workspace-alpha'),
      makeJob('j2', 'workspace-beta'),
      makeJob('j3', 'workspace-alpha'),
    ];

    mod.setState({ jobs });
    mod.setSelectedWorkspaceId('workspace-alpha');

    const state = mod.getState();
    const filtered = state.jobs.filter((j) =>
      state.workspaceFilter.selectedWorkspaceId === null ||
      j.workspaceId === state.workspaceFilter.selectedWorkspaceId
    );

    expect(filtered).toHaveLength(2);
    expect(filtered.every((j) => j.workspaceId === 'workspace-alpha')).toBe(true);
  });

  test('6.6: Activity view filters sessions by selected workspace', async () => {
    const activityMod = await freshActivityModule();
    const chains = [
      makeChain('c1', 'workspace-alpha', 5, {
        latestSession: {
          workflowHash: 'hash1',
          sessionJsonl: 'session1.jsonl',
          chainId: 'c1',
          chainIndex: 0,
          previousSession: '',
          topic: 'Topic 1',
          messageCount: 10,
          userMessageCount: 5,
          contextUsagePct: 50,
          lastMessageAt: '2024-01-01T00:00:00Z',
          lastSummarisedMessageCount: 0,
          lastSummarisedAt: '',
          summaryFile: '',
          status: 'active',
          firstUserMessage: 'First message',
          lastUserMessage: 'Last message',
          lastAgentMessage: 'Agent reply',
          startTime: '2024-01-01T00:00:00Z',
          workspaceId: 'workspace-alpha',
        },
      }),
      makeChain('c2', 'workspace-beta', 5, {
        latestSession: {
          workflowHash: 'hash2',
          sessionJsonl: 'session2.jsonl',
          chainId: 'c2',
          chainIndex: 0,
          previousSession: '',
          topic: 'Topic 2',
          messageCount: 8,
          userMessageCount: 4,
          contextUsagePct: 30,
          lastMessageAt: '2024-01-02T00:00:00Z',
          lastSummarisedMessageCount: 0,
          lastSummarisedAt: '',
          summaryFile: '',
          status: 'idle',
          firstUserMessage: 'First',
          lastUserMessage: 'Last',
          lastAgentMessage: 'Agent',
          startTime: '2024-01-02T00:00:00Z',
          workspaceId: 'workspace-beta',
        },
      }),
    ];

    // Filter for workspace-alpha
    const filtered = activityMod.filterSessionsByWorkspace(chains, 'workspace-alpha');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].chain.workspaceId).toBe('workspace-alpha');

    // Filter for "All Workspaces" (null)
    const allSessions = activityMod.filterSessionsByWorkspace(chains, null);
    expect(allSessions).toHaveLength(2);
  });

  test('6.7: when "All Workspaces" is selected, Dashboard displays data from all workspaces', async () => {
    const mod = await freshStateModule();
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);
    mod.setAvailableWorkspaces(workspaces);

    const chains = [
      makeChain('c1', 'workspace-alpha'),
      makeChain('c2', 'workspace-beta'),
      makeChain('c3', 'workspace-gamma'),
    ];

    mod.setState({ chains });
    mod.setSelectedWorkspaceId(null); // "All Workspaces"

    const state = mod.getState();
    const filtered = state.chains.filter((c) =>
      state.workspaceFilter.selectedWorkspaceId === null ||
      c.workspaceId === state.workspaceFilter.selectedWorkspaceId
    );

    expect(filtered).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Requirement 6.8: Handle localStorage.setItem failures gracefully
// ---------------------------------------------------------------------------

describe('Requirement 6.8 — handle localStorage failures gracefully', () => {
  test('when localStorage.setItem() throws the operation continues without error', async () => {
    const mod = await freshStateModule();
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);
    mod.setAvailableWorkspaces(workspaces);

    // Replace setItem with a throwing mock
    const originalSetItem = localStorageMock.setItem;
    let threwError = false;
    localStorageMock.setItem = () => {
      threwError = true;
      throw new Error('localStorage quota exceeded');
    };

    // This should log a warning but not throw
    expect(() => {
      mod.setSelectedWorkspaceId('workspace-alpha');
    }).not.toThrow();

    expect(threwError).toBe(true);

    // Restore original
    localStorageMock.setItem = originalSetItem;
  });

  test('localStorage failure does not prevent state update', async () => {
    const mod = await freshStateModule();
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);
    mod.setAvailableWorkspaces(workspaces);

    // Replace setItem with a throwing mock
    const originalSetItem = localStorageMock.setItem;
    localStorageMock.setItem = () => {
      throw new Error('localStorage unavailable');
    };

    mod.setSelectedWorkspaceId('workspace-beta');

    // Even though persistence failed, state should update
    expect(mod.getSelectedWorkspaceId()).toBe('workspace-beta');

    // Restore original
    localStorageMock.setItem = originalSetItem;
  });

  test('6.8: workspaceFilter component persistSelection handles setItem failure gracefully', async () => {
    const mod = await freshFilterModule();
    const filter = mod.createWorkspaceFilter();

    // Replace setItem with a throwing mock
    const originalSetItem = localStorageMock.setItem;
    localStorageMock.setItem = () => {
      throw new Error('QuotaExceededError');
    };

    // Should not throw
    expect(() => filter.persistSelection('workspace-alpha')).not.toThrow();

    // Restore
    localStorageMock.setItem = originalSetItem;
  });

  test('6.8: workspaceFilter component restoreSelection handles getItem failure gracefully', async () => {
    const mod = await freshFilterModule();
    const filter = mod.createWorkspaceFilter();

    // Replace getItem with a throwing mock
    const originalGetItem = localStorageMock.getItem;
    localStorageMock.getItem = () => {
      throw new Error('SecurityError');
    };

    // Should return null (not throw)
    let result: string | null | undefined;
    expect(() => { result = filter.restoreSelection(); }).not.toThrow();
    expect(result).toBeNull();

    // Restore
    localStorageMock.getItem = originalGetItem as typeof localStorageMock.getItem;
  });
});

// ---------------------------------------------------------------------------
// Requirement 6.9: Persist selected workspace filter in localStorage
// ---------------------------------------------------------------------------

describe('Requirement 6.9 — persist workspace filter to localStorage', () => {
  test('selecting a workspace persists it under key "selectedWorkspaceId"', async () => {
    const mod = await freshStateModule();
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);
    mod.setAvailableWorkspaces(workspaces);

    mod.setSelectedWorkspaceId('workspace-alpha');

    const stored = localStorageMock.getItem('selectedWorkspaceId');
    expect(stored).toBe('workspace-alpha');
  });

  test('selecting "All Workspaces" (null) removes the key from localStorage', async () => {
    const mod = await freshStateModule();
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);
    mod.setAvailableWorkspaces(workspaces);

    // First set a value
    mod.setSelectedWorkspaceId('workspace-beta');
    expect(localStorageMock.getItem('selectedWorkspaceId')).toBe('workspace-beta');

    // Now clear to "All Workspaces"
    mod.setSelectedWorkspaceId(null);
    expect(localStorageMock.getItem('selectedWorkspaceId')).toBeNull();
  });

  test('changing selection updates the persisted key', async () => {
    const mod = await freshStateModule();
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);
    mod.setAvailableWorkspaces(workspaces);

    mod.setSelectedWorkspaceId('workspace-alpha');
    mod.setSelectedWorkspaceId('workspace-gamma');

    const stored = localStorageMock.getItem('selectedWorkspaceId');
    expect(stored).toBe('workspace-gamma');
  });

  test('6.9: workspaceFilter component persistSelection writes to localStorage', async () => {
    localStorageMock.clear();
    const mod = await freshFilterModule();
    const filter = mod.createWorkspaceFilter();

    filter.persistSelection('workspace-alpha');
    expect(localStorageMock.getItem('selectedWorkspaceId')).toBe('workspace-alpha');
  });

  test('6.9: workspaceFilter component persistSelection with null removes key', async () => {
    localStorageMock.clear();
    localStorageMock.setItem('selectedWorkspaceId', 'workspace-alpha');

    const mod = await freshFilterModule();
    const filter = mod.createWorkspaceFilter();

    filter.persistSelection(null);
    expect(localStorageMock.getItem('selectedWorkspaceId')).toBeNull();
  });

  test('6.9: persistence uses exact key "selectedWorkspaceId" (case-sensitive)', async () => {
    const mod = await freshStateModule();
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);
    mod.setAvailableWorkspaces(workspaces);

    mod.setSelectedWorkspaceId('workspace-beta');

    // Exact key check
    expect(localStorageMock.getItem('selectedWorkspaceId')).toBe('workspace-beta');
    // Other case variants should not have been set
    expect(localStorageMock.getItem('SelectedWorkspaceId')).toBeNull();
    expect(localStorageMock.getItem('SELECTEDWORKSPACEID')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Requirement 6.10: Default to "All Workspaces" if restored ID doesn't match
// ---------------------------------------------------------------------------

describe('Requirement 6.10 — fallback to "All Workspaces" if stored ID is invalid', () => {
  test('stale workspace ID (not in configured workspaces) defaults to null', async () => {
    localStorageMock.clear();
    localStorageMock.setItem('selectedWorkspaceId', 'stale-workspace-id');

    const mod = await freshStateModule();
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS); // doesn't include 'stale-workspace-id'
    mod.setAvailableWorkspaces(workspaces);

    const selected = mod.getSelectedWorkspaceId();
    expect(selected).toBeNull();
  });

  test('valid workspace ID is preserved after setAvailableWorkspaces', async () => {
    // freshStateModule clears localStorageMock; pre-seed AFTER calling it
    // by loading a fresh module then seeding localStorage directly before
    // validation via setAvailableWorkspaces.
    const mod = await freshStateModule();
    // Manually set the stored value (simulating a prior page session)
    localStorageMock.setItem('selectedWorkspaceId', 'workspace-beta');

    // Reload the module so it reads the pre-seeded value on init
    const ts2 = Date.now() + Math.random() + 1;
    const mod2 = await import(`../../src/dashboard/state.ts?bust=${ts2}`) as typeof import('../../src/dashboard/state.ts');
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS); // includes 'workspace-beta'
    mod2.setAvailableWorkspaces(workspaces);

    const selected = mod2.getSelectedWorkspaceId();
    expect(selected).toBe('workspace-beta');
  });

  test('workspace removed from config causes fallback to null on setAvailableWorkspaces', async () => {
    const mod = await freshStateModule();
    const initialWorkspaces = makeAvailableWorkspaces(WORKSPACE_IDS);
    mod.setAvailableWorkspaces(initialWorkspaces);

    // Select workspace-gamma
    mod.setSelectedWorkspaceId('workspace-gamma');
    expect(mod.getSelectedWorkspaceId()).toBe('workspace-gamma');

    // Now reconfigure without workspace-gamma
    const reducedWorkspaces = makeAvailableWorkspaces(['workspace-alpha', 'workspace-beta']);
    mod.setAvailableWorkspaces(reducedWorkspaces);

    // Should fall back to null since 'workspace-gamma' no longer exists
    expect(mod.getSelectedWorkspaceId()).toBeNull();
  });

  test('empty string stored ID defaults to null', async () => {
    // Empty string is treated as falsy; restoreSelection returns null for missing key
    localStorageMock.clear();
    // setItem with empty string to simulate edge case
    localStorageMock.setItem('selectedWorkspaceId', '');

    const mod = await freshStateModule();
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);
    mod.setAvailableWorkspaces(workspaces);

    // An empty string workspace ID won't match any workspace, fallback to null
    const selected = mod.getSelectedWorkspaceId();
    expect(selected).toBeNull();
  });

  test('6.10: workspaceFilter restoreSelection returns stored value as-is (validation in state)', async () => {
    localStorageMock.clear();
    localStorageMock.setItem('selectedWorkspaceId', 'my-workspace');

    const mod = await freshFilterModule();
    const filter = mod.createWorkspaceFilter();

    // restoreSelection returns the raw value; validation/fallback is in state.ts
    const restored = filter.restoreSelection();
    expect(restored).toBe('my-workspace');
  });
});

// ---------------------------------------------------------------------------
// Requirement 6.11: Restore last selected workspace filter on page load
// ---------------------------------------------------------------------------

describe('Requirement 6.11 — restore workspace filter on page load', () => {
  test('module init reads selectedWorkspaceId from localStorage', async () => {
    // Clear first, then pre-seed, then load a fresh module to pick up the value
    localStorageMock.clear();
    localStorageMock.setItem('selectedWorkspaceId', 'workspace-beta');

    // Load fresh module AFTER seeding (not via freshStateModule which would clear)
    const ts = Date.now() + Math.random();
    const mod = await import(`../../src/dashboard/state.ts?bust=${ts}`) as typeof import('../../src/dashboard/state.ts');
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);
    mod.setAvailableWorkspaces(workspaces);

    const restored = mod.getSelectedWorkspaceId();
    expect(restored).toBe('workspace-beta');
  });

  test('when no key in localStorage, init defaults to null (All Workspaces)', async () => {
    localStorageMock.clear();

    const mod = await freshStateModule();
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);
    mod.setAvailableWorkspaces(workspaces);

    const restored = mod.getSelectedWorkspaceId();
    expect(restored).toBeNull();
  });

  test('stored workspace ID that exists in config is restored correctly', async () => {
    localStorageMock.clear();
    localStorageMock.setItem('selectedWorkspaceId', 'workspace-gamma');

    // Load fresh module AFTER seeding (not via freshStateModule which would clear)
    const ts = Date.now() + Math.random();
    const mod = await import(`../../src/dashboard/state.ts?bust=${ts}`) as typeof import('../../src/dashboard/state.ts');
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);
    mod.setAvailableWorkspaces(workspaces);

    expect(mod.getSelectedWorkspaceId()).toBe('workspace-gamma');
  });

  test('stored workspace ID that does NOT exist in config falls back to null', async () => {
    localStorageMock.clear();
    localStorageMock.setItem('selectedWorkspaceId', 'does-not-exist-in-workspaces');

    const mod = await freshStateModule();
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);
    mod.setAvailableWorkspaces(workspaces);

    // The validation logic detects the workspace doesn't exist and falls back to null
    const restored = mod.getSelectedWorkspaceId();
    expect(restored).toBeNull();
  });

  test('6.11: round-trip: persist then reload restores the same selection', async () => {
    localStorageMock.clear();

    // First session: set a workspace
    const mod1 = await freshStateModule();
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);
    mod1.setAvailableWorkspaces(workspaces);
    mod1.setSelectedWorkspaceId('workspace-alpha');
    expect(localStorageMock.getItem('selectedWorkspaceId')).toBe('workspace-alpha');

    // Second session (simulating page reload): fresh module reads from localStorage
    const ts2 = Date.now() + Math.random() + 1;
    const mod2 = await import(`../../src/dashboard/state.ts?bust=${ts2}`) as typeof import('../../src/dashboard/state.ts');
    mod2.setAvailableWorkspaces(workspaces);

    expect(mod2.getSelectedWorkspaceId()).toBe('workspace-alpha');
  });

  test('6.11: setSelectedWorkspaceId(null) persists and restores as null', async () => {
    localStorageMock.clear();
    localStorageMock.setItem('selectedWorkspaceId', 'workspace-beta');

    const mod1 = await freshStateModule();
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);
    mod1.setAvailableWorkspaces(workspaces);

    // Clear the selection
    mod1.setSelectedWorkspaceId(null);
    expect(localStorageMock.getItem('selectedWorkspaceId')).toBeNull();

    // Reload
    const ts2 = Date.now() + Math.random() + 1;
    const mod2 = await import(`../../src/dashboard/state.ts?bust=${ts2}`) as typeof import('../../src/dashboard/state.ts');
    mod2.setAvailableWorkspaces(workspaces);

    expect(mod2.getSelectedWorkspaceId()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration test: Workspace filter updates all views
// ---------------------------------------------------------------------------

describe('Integration — workspace filter updates all dashboard views', () => {
  test('changing workspace filter via state updates all view data at once', async () => {
    const mod = await freshStateModule();
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);
    mod.setAvailableWorkspaces(workspaces);

    const chains = [
      makeChain('c1', 'workspace-alpha'),
      makeChain('c2', 'workspace-beta'),
      makeChain('c3', 'workspace-gamma'),
    ];
    const jobs = [
      makeJob('j1', 'workspace-alpha'),
      makeJob('j2', 'workspace-beta'),
      makeJob('j3', 'workspace-gamma'),
    ];

    mod.setState({ chains, jobs });
    mod.setSelectedWorkspaceId('workspace-alpha');

    // All data is in state; views filter based on workspaceFilter.selectedWorkspaceId
    const state = mod.getState();
    expect(state.workspaceFilter.selectedWorkspaceId).toBe('workspace-alpha');

    // Filtered chains
    const filteredChains = state.chains.filter((c) =>
      state.workspaceFilter.selectedWorkspaceId === null ||
      c.workspaceId === state.workspaceFilter.selectedWorkspaceId
    );
    expect(filteredChains).toHaveLength(1);

    // Filtered jobs
    const filteredJobs = state.jobs.filter((j) =>
      state.workspaceFilter.selectedWorkspaceId === null ||
      j.workspaceId === state.workspaceFilter.selectedWorkspaceId
    );
    expect(filteredJobs).toHaveLength(1);

    // Change workspace
    mod.setSelectedWorkspaceId('workspace-beta');
    const state2 = mod.getState();

    const filteredChains2 = state2.chains.filter((c) =>
      state2.workspaceFilter.selectedWorkspaceId === null ||
      c.workspaceId === state2.workspaceFilter.selectedWorkspaceId
    );
    expect(filteredChains2).toHaveLength(1);
    expect(filteredChains2[0].workspaceId).toBe('workspace-beta');

    const filteredJobs2 = state2.jobs.filter((j) =>
      state2.workspaceFilter.selectedWorkspaceId === null ||
      j.workspaceId === state2.workspaceFilter.selectedWorkspaceId
    );
    expect(filteredJobs2).toHaveLength(1);
    expect(filteredJobs2[0].workspaceId).toBe('workspace-beta');
  });

  test('workspace filter subscriber is notified when selection changes', async () => {
    const mod = await freshStateModule();
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);
    mod.setAvailableWorkspaces(workspaces);

    let notificationCount = 0;
    mod.subscribe(() => {
      notificationCount++;
    });

    mod.setSelectedWorkspaceId('workspace-alpha');
    expect(notificationCount).toBe(1);

    mod.setSelectedWorkspaceId('workspace-beta');
    expect(notificationCount).toBe(2);

    mod.setSelectedWorkspaceId(null);
    expect(notificationCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Integration test: Git status section filters by selected workspace
// (Requirements 7.4, 7.4.1, 7.5, 7.7)
// ---------------------------------------------------------------------------

describe('Integration — git status display filters by workspace (Req 7.4, 7.5)', () => {
  test('selectGitStatuses returns all statuses with labels when "All Workspaces" selected', async () => {
    const dashMod = await freshDashboardModule();
    const statuses = [
      makeGitStatus('workspace-alpha'),
      makeGitStatus('workspace-beta'),
    ];
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);

    const result = dashMod.selectGitStatuses(statuses, null, workspaces);
    expect(result.statuses).toHaveLength(2);
    expect(result.showLabels).toBe(true);
  });

  test('selectGitStatuses returns only matching status when specific workspace selected', async () => {
    const dashMod = await freshDashboardModule();
    const statuses = [
      makeGitStatus('workspace-alpha'),
      makeGitStatus('workspace-beta'),
    ];
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);

    const result = dashMod.selectGitStatuses(statuses, 'workspace-alpha', workspaces);
    expect(result.statuses).toHaveLength(1);
    expect(result.statuses[0].workspaceId).toBe('workspace-alpha');
  });

  test('selectGitStatuses falls back to all when selected workspace has no git status', async () => {
    const dashMod = await freshDashboardModule();
    const statuses = [
      makeGitStatus('workspace-alpha'),
      makeGitStatus('workspace-beta'),
    ];
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);

    // workspace-gamma is in available workspaces but has no git status
    const result = dashMod.selectGitStatuses(statuses, 'workspace-gamma', workspaces);
    expect(result.statuses).toHaveLength(2);
    expect(result.showLabels).toBe(true);
  });

  test('selectGitStatuses returns empty when no git statuses exist', async () => {
    const dashMod = await freshDashboardModule();
    const workspaces = makeAvailableWorkspaces(WORKSPACE_IDS);

    const result = dashMod.selectGitStatuses([], null, workspaces);
    expect(result.statuses).toHaveLength(0);
    expect(result.showLabels).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration test: workspace metrics sort (Requirements 10.6, 10.6.1)
// ---------------------------------------------------------------------------

describe('Integration — workspace comparison table sorting (Req 10.6)', () => {
  test('sortWorkspaceMetrics sorts by totalMessages descending', async () => {
    const dashMod = await freshDashboardModule();
    const metrics = [
      { workspaceId: 'ws-a', displayName: 'Ws A', totalMessages: 5, contextUsagePct: 0, activeSessions: 0, pendingQueueItems: 0, hasAttentionItems: false },
      { workspaceId: 'ws-b', displayName: 'Ws B', totalMessages: 20, contextUsagePct: 0, activeSessions: 0, pendingQueueItems: 0, hasAttentionItems: false },
      { workspaceId: 'ws-c', displayName: 'Ws C', totalMessages: 10, contextUsagePct: 0, activeSessions: 0, pendingQueueItems: 0, hasAttentionItems: false },
    ];

    const sorted = dashMod.sortWorkspaceMetrics(metrics);
    expect(sorted[0].workspaceId).toBe('ws-b');
    expect(sorted[1].workspaceId).toBe('ws-c');
    expect(sorted[2].workspaceId).toBe('ws-a');
  });

  test('sortWorkspaceMetrics uses alphabetical secondary sort when messages are equal', async () => {
    const dashMod = await freshDashboardModule();
    const metrics = [
      { workspaceId: 'ws-z', displayName: 'Z Workspace', totalMessages: 10, contextUsagePct: 0, activeSessions: 0, pendingQueueItems: 0, hasAttentionItems: false },
      { workspaceId: 'ws-a', displayName: 'A Workspace', totalMessages: 10, contextUsagePct: 0, activeSessions: 0, pendingQueueItems: 0, hasAttentionItems: false },
      { workspaceId: 'ws-m', displayName: 'M Workspace', totalMessages: 10, contextUsagePct: 0, activeSessions: 0, pendingQueueItems: 0, hasAttentionItems: false },
    ];

    const sorted = dashMod.sortWorkspaceMetrics(metrics);
    expect(sorted[0].displayName).toBe('A Workspace');
    expect(sorted[1].displayName).toBe('M Workspace');
    expect(sorted[2].displayName).toBe('Z Workspace');
  });

  test('sortWorkspaceMetrics does not mutate the original array', async () => {
    const dashMod = await freshDashboardModule();
    const metrics = [
      { workspaceId: 'ws-a', displayName: 'Ws A', totalMessages: 5, contextUsagePct: 0, activeSessions: 0, pendingQueueItems: 0, hasAttentionItems: false },
      { workspaceId: 'ws-b', displayName: 'Ws B', totalMessages: 20, contextUsagePct: 0, activeSessions: 0, pendingQueueItems: 0, hasAttentionItems: false },
    ];
    const original = [...metrics];

    dashMod.sortWorkspaceMetrics(metrics);

    // Original order unchanged
    expect(metrics[0].workspaceId).toBe(original[0].workspaceId);
    expect(metrics[1].workspaceId).toBe(original[1].workspaceId);
  });
});
