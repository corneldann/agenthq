// main.ts — app bootstrap, router, sidebar, keyboard shortcuts
// Feature: monitor-dashboard-redesign
// Implements Requirements 2.1, 2.2, 2.5, 12.1–12.6
// Also implements Requirements 11.6, 11.6.1, 11.7 (SSE client-side filtering)

import { getState, setState, subscribe, getSelectedWorkspaceId } from './state';
import { fetchAll } from './api';
import { togglePalette, isPaletteOpen } from './palette';
import './toast'; // ensure toast module is loaded so enqueueToast is available
import { initDrawer } from './components/drawer';
import { renderDashboard } from './pages/dashboard';
import { renderWork } from './pages/work';
import { renderActivity } from './pages/activity';
import { renderAnalyticsPage, loadAnalytics, initAnalyticsPage } from './pages/analytics';
import { renderMemoryPage, initMemoryPage, refreshMemoryList } from './pages/memory';
import type { Page, SSEUpdateEvent } from './types';
import { shouldApplySSEUpdate } from './sse-filter';

// Re-export for external consumers (e.g. tests that import from main)
export { shouldApplySSEUpdate };

// ---------------------------------------------------------------------------
// Shortcuts overlay data (Requirement 12.4, 12.5)
// ---------------------------------------------------------------------------

const SHORTCUTS: Array<{ keys: string; action: string }> = [
  { keys: 'G → D',        action: 'Navigate to Dashboard' },
  { keys: 'G → W',        action: 'Navigate to Work' },
  { keys: 'G → A',        action: 'Navigate to Activity' },
  { keys: 'G → M',        action: 'Navigate to Memory' },
  { keys: '?',            action: 'Toggle shortcuts overlay' },
  { keys: 'Cmd/Ctrl + K', action: 'Toggle command palette' },
  { keys: 'Escape',       action: 'Close palette / overlay / drawer' },
];

let _overlayEl: HTMLElement | null = null;

function isOverlayOpen(): boolean {
  return _overlayEl !== null && document.body.contains(_overlayEl);
}

function openOverlay(): void {
  if (isOverlayOpen()) return;

  const backdrop = document.createElement('div');
  backdrop.id = 'shortcuts-overlay';
  Object.assign(backdrop.style, {
    position: 'fixed',
    inset: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.55)',
    zIndex: '9999',
  });

  const panel = document.createElement('div');
  Object.assign(panel.style, {
    background: 'var(--surface, #1a1d27)',
    border: '1px solid var(--border, #2a2d3e)',
    borderRadius: '8px',
    padding: '24px 32px',
    minWidth: '360px',
    color: 'var(--text, #e2e8f0)',
    fontFamily: 'inherit',
  });

  const title = document.createElement('h2');
  title.textContent = 'Keyboard Shortcuts';
  Object.assign(title.style, {
    margin: '0 0 16px 0',
    fontSize: '14px',
    fontWeight: '600',
    letterSpacing: '0.04em',
    color: 'var(--text, #e2e8f0)',
  });
  panel.appendChild(title);

  const table = document.createElement('table');
  Object.assign(table.style, {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '12px',
  });

  SHORTCUTS.forEach(({ keys, action }) => {
    const tr = document.createElement('tr');

    const tdKeys = document.createElement('td');
    tdKeys.textContent = keys;
    Object.assign(tdKeys.style, {
      padding: '6px 12px 6px 0',
      color: 'var(--accent, #3b82f6)',
      fontFamily: 'inherit',
      whiteSpace: 'nowrap',
    });

    const tdAction = document.createElement('td');
    tdAction.textContent = action;
    Object.assign(tdAction.style, {
      padding: '6px 0',
      color: 'var(--muted, #6b7280)',
    });

    tr.appendChild(tdKeys);
    tr.appendChild(tdAction);
    table.appendChild(tr);
  });

  panel.appendChild(table);
  backdrop.appendChild(panel);

  // Close on backdrop click
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeOverlay();
  });

  document.body.appendChild(backdrop);
  _overlayEl = backdrop;
}

function closeOverlay(): void {
  if (_overlayEl) {
    _overlayEl.remove();
    _overlayEl = null;
  }
}

function toggleOverlay(): void {
  if (isOverlayOpen()) {
    closeOverlay();
  } else {
    openOverlay();
  }
}

// ---------------------------------------------------------------------------
// Router (Requirements 2.1, 2.2)
// ---------------------------------------------------------------------------

function renderPage(): void {
  const root = document.getElementById('page-root');
  if (!root) return;

  const { currentPage } = getState();

  // Clear existing content
  root.innerHTML = '';

  switch (currentPage) {
    case 'dashboard':
      renderDashboard(root);
      break;
    case 'work':
      renderWork(root);
      break;
    case 'activity':
      renderActivity(root);
      break;
    case 'analytics':
      root.innerHTML = renderAnalyticsPage();
      initAnalyticsPage();
      break;
    case 'memory':
      root.innerHTML = renderMemoryPage();
      initMemoryPage();
      break;
    default: {
      // Exhaustiveness guard — TypeScript should prevent this at compile time
      const _exhaustive: never = currentPage;
      console.warn('Unknown page:', _exhaustive);
    }
  }
}

// ---------------------------------------------------------------------------
// Sidebar (Requirement 2.5)
// ---------------------------------------------------------------------------

const NAV_ITEMS: Array<{ page: Page; icon: string; label: string }> = [
  { page: 'dashboard', icon: '⊞', label: 'Dashboard' },
  { page: 'work',      icon: '⚙', label: 'Work' },
  { page: 'activity',  icon: '◷', label: 'Activity' },
  { page: 'analytics', icon: '◈', label: 'Analytics' },
  { page: 'memory',    icon: '◉', label: 'Memory' },
];

/** Rendered once; state updates are applied via class mutations only. */
function renderSidebar(): void {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  // Brand
  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.textContent = 'Agent HQ';
  sidebar.appendChild(brand);

  // Nav
  const nav = document.createElement('nav');

  const navLinks: Map<Page, HTMLAnchorElement> = new Map();

  NAV_ITEMS.forEach(({ page, icon, label }) => {
    const a = document.createElement('a');
    a.dataset['page'] = page;
    a.href = '#';

    const iconSpan = document.createElement('span');
    iconSpan.textContent = icon;

    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;

    a.appendChild(iconSpan);
    a.appendChild(labelSpan);

    if (page === 'work') {
      const dot = document.createElement('span');
      dot.className = 'work-dot';
      a.appendChild(dot);
    }

    a.addEventListener('click', (e) => {
      e.preventDefault();
      setState({ currentPage: page });
    });

    navLinks.set(page, a);
    nav.appendChild(a);
  });

  sidebar.appendChild(nav);

  // Footer with Stop button
  const footer = document.createElement('div');
  footer.className = 'sidebar-footer';
  footer.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:8px';

  const restartBtn = document.createElement('button');
  restartBtn.textContent = '↺ Restart';
  restartBtn.title = 'Restart monitor process';
  restartBtn.addEventListener('click', () => {
    restartBtn.textContent = '↺ Restarting…';
    restartBtn.disabled = true;
    fetch('/restart', { method: 'POST' }).catch(() => {/* expected — process exits */});
    setTimeout(() => {
      restartBtn.textContent = '↺ Restart';
      restartBtn.disabled = false;
    }, 5000);
  });

  const stopBtn = document.createElement('button');
  stopBtn.textContent = '⏹ Stop Agent';
  stopBtn.addEventListener('click', () => {
    fetch('/stop', { method: 'POST' }).catch((err) =>
      console.error('Stop request failed:', err)
    );
  });

  footer.appendChild(restartBtn);
  footer.appendChild(stopBtn);
  sidebar.appendChild(footer);

  // Subscribe to state changes to update .active and .has-running classes
  // without re-rendering the whole sidebar (Requirement 2.5)
  subscribe(() => {
    const { currentPage, jobs } = getState();
    const hasRunning = jobs.some((j) => j.status === 'running');

    navLinks.forEach((link, page) => {
      link.classList.toggle('active', page === currentPage);
      if (page === 'work') {
        link.classList.toggle('has-running', hasRunning);
      }
    });
  });

  // Apply initial classes
  const { currentPage, jobs } = getState();
  const hasRunning = jobs.some((j) => j.status === 'running');
  navLinks.forEach((link, page) => {
    link.classList.toggle('active', page === currentPage);
    if (page === 'work') {
      link.classList.toggle('has-running', hasRunning);
    }
  });
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts (Requirements 12.1–12.6)
// ---------------------------------------------------------------------------

let _pendingG = 0; // timestamp of last G keypress

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (target.isContentEditable) return true;
  return false;
}

function registerKeyboardShortcuts(): void {
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (isEditableTarget(e.target)) return;

    const key = e.key.toUpperCase();

    // Escape — close palette → overlay → drawer, in priority order
    if (e.key === 'Escape') {
      if (isPaletteOpen()) {
        togglePalette();
      } else if (isOverlayOpen()) {
        closeOverlay();
      } else if (getState().drawerChainId !== null) {
        setState({ drawerChainId: null });
      }
      return;
    }

    // Cmd/Ctrl+K — toggle palette
    if ((e.metaKey || e.ctrlKey) && key === 'K') {
      e.preventDefault();
      togglePalette();
      return;
    }

    // ? — toggle shortcuts overlay
    if (e.key === '?') {
      toggleOverlay();
      return;
    }

    // G → D / W / A / M navigation (Requirement 12.2, 12.3)
    if (key === 'G') {
      _pendingG = Date.now();
      return;
    }

    if (_pendingG > 0 && Date.now() - _pendingG <= 1500) {
      if (key === 'D') {
        setState({ currentPage: 'dashboard' });
        _pendingG = 0;
        return;
      }
      if (key === 'W') {
        setState({ currentPage: 'work' });
        _pendingG = 0;
        return;
      }
      if (key === 'A') {
        setState({ currentPage: 'activity' });
        _pendingG = 0;
        return;
      }
      if (key === 'M') {
        setState({ currentPage: 'memory' });
        _pendingG = 0;
        return;
      }
      // Any other key after G within window — clear pending
      _pendingG = 0;
    } else if (_pendingG > 0) {
      // G timeout expired — clear
      _pendingG = 0;
    }
  });
}

// ---------------------------------------------------------------------------
// Memory update listener registry (Phase 6.4, Requirement 4.4)
// ---------------------------------------------------------------------------

/**
 * WeakRef-based registry for memory update listeners.
 * Allows listeners to be garbage collected if unmount fails.
 * Periodic sweep (30s interval) removes dead WeakRef entries as failsafe.
 */
const _listenerRegistry: Map<string, WeakRef<() => void>> = new Map();

/**
 * Registers a listener for memory update events.
 * Listener will be invoked when memory-update SSE events are received.
 * 
 * @param id - Unique identifier for the listener (e.g., 'memory-page')
 * @param fn - Callback function to invoke on memory update
 */
export function registerMemoryUpdateListener(id: string, fn: () => void): void {
  _listenerRegistry.set(id, new WeakRef(fn));
}

/**
 * Deregisters a memory update listener by ID.
 * 
 * @param id - Unique identifier of the listener to remove
 */
export function deregisterMemoryUpdateListener(id: string): void {
  _listenerRegistry.delete(id);
}

/**
 * Invokes all registered memory update listeners.
 * Called by the memory-update SSE handler in attach().
 * Automatically skips dead WeakRef entries.
 * 
 * Exported for testing purposes.
 */
export function notifyMemoryUpdateListeners(): void {
  for (const [id, weakRef] of _listenerRegistry) {
    const fn = weakRef.deref();
    if (fn) {
      try {
        fn();
      } catch (err) {
        console.error(`[memory-listener] Listener "${id}" failed:`, err);
      }
    }
  }
}

/**
 * Periodic cleanup: removes dead WeakRef entries from the registry.
 * Runs every 30 seconds as failsafe (normal cleanup via explicit deregister).
 */
setInterval(() => {
  const deadIds: string[] = [];
  
  for (const [id, weakRef] of _listenerRegistry) {
    if (!weakRef.deref()) {
      deadIds.push(id);
    }
  }
  
  for (const id of deadIds) {
    _listenerRegistry.delete(id);
  }
  
  if (deadIds.length > 0) {
    console.log(`[memory-listener] Swept ${deadIds.length} dead listener(s):`, deadIds);
  }
}, 30_000);

// ---------------------------------------------------------------------------
// SSE client with reconnect logic (Requirements 9.1–9.5)
// ---------------------------------------------------------------------------

/** Module-level reference to the active EventSource. */
let _es: EventSource | null = null;

/** Consecutive onerror fires since last successful message. */
let _retryCount = 0;

/** Max reconnect attempts before rendering the permanent disconnected banner. */
const MAX_RETRIES = 10;

/** Delay between reconnect attempts in milliseconds. */
const RETRY_DELAY_MS = 5000;

/**
 * Wires onmessage and onerror onto the given EventSource.
 * Extracted as a helper so each new EventSource created during reconnect
 * gets identical handlers without duplication.
 *
 * Requirements 9.3, 9.4: compare prevJobs → newJobs after each fetch and
 * enqueue success/error toasts for running→done and running→error transitions.
 * Requirement 9.5: reconnect loop capped at MAX_RETRIES attempts.
 */
function attach(es: EventSource): void {
  es.onmessage = (_ev: MessageEvent): void => {
    // Reset retry counter — a message means the connection is healthy (Req 9.5)
    _retryCount = 0;

    // Apply client-side SSE filtering based on workspace selection
    // (Requirements 11.6, 11.6.1, 11.7)
    //
    // The broadcaster sends two kinds of messages:
    //   1. Plain "update" string  — from the change-detection interval
    //   2. Structured JSON        — from emitSSEUpdate (typed SSEUpdateEvent)
    //
    // For structured events we check the workspace filter before fetching.
    // Plain "update" strings are treated as unfiltered and always applied
    // (they trigger a full data refresh and carry no workspace context).
    let applyUpdate = true;
    let parsedEvent: SSEUpdateEvent | null = null;
    
    try {
      const parsed = JSON.parse(_ev.data) as SSEUpdateEvent;
      // Only filter if this looks like a structured SSEUpdateEvent
      if (parsed && typeof parsed === 'object' && 'type' in parsed) {
        parsedEvent = parsed;
        const selectedWorkspace = getSelectedWorkspaceId();
        applyUpdate = shouldApplySSEUpdate(parsed, selectedWorkspace);
      }
    } catch {
      // Non-JSON data (e.g. plain "update" string) — always apply
      applyUpdate = true;
    }

    if (!applyUpdate) return;

    // Handle memory-update events (Phase 6.4, Requirement 4.3)
    // If we're on the memory page and receive a memory-update event,
    // notify all registered listeners (memory page listener will refresh silently)
    if (parsedEvent?.type === 'memory-update') {
      const { currentPage } = getState();
      if (currentPage === 'memory') {
        // Notify all registered listeners
        notifyMemoryUpdateListeners();
      }
      // Memory updates don't require a full fetchAll() — early return
      return;
    }

    // Snapshot jobs BEFORE the fetch so we can diff afterwards (Req 9.3, 9.4)
    const prevJobs = getState().jobs;

    void fetchAll().then(async () => {
      const newJobs = getState().jobs;

      // Build id → status lookup for new jobs
      const newStatusById = new Map<string, string>();
      for (const job of newJobs) {
        newStatusById.set(job.id, job.status);
      }

      // Find transitions running → done or running → error
      const transitions = prevJobs.filter(
        (prev) =>
          prev.status === 'running' &&
          (newStatusById.get(prev.id) === 'done' ||
            newStatusById.get(prev.id) === 'error')
      );

      if (transitions.length === 0) return;

      try {
        const { enqueueToast } = await import('./toast.js');
        for (const prev of transitions) {
          const newStatus = newStatusById.get(prev.id);
          if (newStatus === 'done') {
            enqueueToast({
              id: crypto.randomUUID(),
              type: 'success',
              message: `Job done: ${prev.name}`,
              persistent: false,
            });
          } else if (newStatus === 'error') {
            enqueueToast({
              id: crypto.randomUUID(),
              type: 'error',
              message: `Job error: ${prev.name}`,
              persistent: true,
            });
          }
        }
      } catch (err) {
        console.error('[sse] toast import failed:', err);
      }
    });
  };

  es.onerror = (_ev: Event): void => {
    _retryCount += 1;

    // Toggle reconnecting class on status bar (Req 9.1, 9.2)
    const statusBar = document.getElementById('status-bar');
    if (statusBar) {
      statusBar.classList.toggle('reconnecting', true);
    }

    if (_retryCount > MAX_RETRIES) {
      // All retries exhausted — render permanent banner (Req 9.5)
      es.close();
      _es = null;

      if (!document.getElementById('sse-disconnected-banner')) {
        const banner = document.createElement('div');
        banner.id = 'sse-disconnected-banner';
        banner.textContent = '⚠ Live updates disconnected. Reload to reconnect.';
        Object.assign(banner.style, {
          position: 'fixed',
          bottom: '16px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'var(--red, #ef4444)',
          color: 'var(--surface, #0f1117)',
          border: '1px solid var(--border, #2a2d3e)',
          borderRadius: '6px',
          padding: '10px 20px',
          fontSize: '13px',
          fontWeight: '600',
          zIndex: '99999',
          whiteSpace: 'nowrap',
        });
        document.body.appendChild(banner);
      }
      return;
    }

    // Close stale connection and schedule a reconnect (Req 9.5)
    es.close();

    setTimeout(() => {
      const newEs = new EventSource('/events');
      _es = newEs;
      attach(newEs);
    }, RETRY_DELAY_MS);
  };
}

/**
 * Creates the initial EventSource and starts the SSE lifecycle.
 * Called once during app init.
 *
 * Requirements 9.1, 9.2, 9.3, 9.4, 9.5.
 */
function startSSEClient(): void {
  _es = new EventSource('/events');
  attach(_es);
}

// ---------------------------------------------------------------------------
// Init (runs on module load)
// ---------------------------------------------------------------------------

renderSidebar();
initDrawer();
subscribe(renderPage);
renderPage();
registerKeyboardShortcuts();
void fetchAll();
startSSEClient();

// ---------------------------------------------------------------------------
// Global summarise event handler
// Listens for 'chain:summarise' (from chainCard) and 'attention:summarise'
// (from attentionRow) and calls POST /summarise/:chainId
// ---------------------------------------------------------------------------

function handleSummarise(chainId: string): void {
  if (!chainId) return;
  fetch(`/summarise/${encodeURIComponent(chainId)}`, { method: 'POST' })
    .then(async (res) => {
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[summarise] POST /summarise/${chainId} failed (${res.status}): ${body}`);
      }
    })
    .catch((err) => console.error(`[summarise] network error for ${chainId}:`, err));
}

document.addEventListener('chain:summarise', (e: Event) => {
  const detail = (e as CustomEvent<{ chainId: string }>).detail;
  handleSummarise(detail?.chainId ?? '');
});

document.addEventListener('attention:summarise', (e: Event) => {
  const detail = (e as CustomEvent<{ chainId: string }>).detail;
  handleSummarise(detail?.chainId ?? '');
});
