// components/drawer.ts — slide-in session timeline drawer
// Feature: monitor-dashboard-redesign
// Implements Requirements 16.1, 16.2, 16.3, 16.4, 16.5

import { getState, setState, subscribe } from '../state.js';
import { el, formatDate, clampText } from '../utils.js';

// ---------------------------------------------------------------------------
// Types for chain-detail API response
// ---------------------------------------------------------------------------

interface ChainDetailSession {
  index: number;
  date: string;
  messageCount: number;
  status: string;
  contextUsagePct: number;
  firstUserMessage: string;
  lastUserMessage: string;
  lastAgentMessage: string;
  topic: string;
  workflowHash: string;
}

interface ChainDetail {
  chainId: string;
  displayName: string;
  totalMessages: number;
  workflowCount?: number;
  createdAt: string;
  lastActiveAt: string;
  overallStatus?: string;
  timeline: ChainDetailSession[];
}

// ---------------------------------------------------------------------------
// Module-level DOM references (set once by initDrawer)
// ---------------------------------------------------------------------------

let _drawerEl: HTMLElement | null = null;
let _contentEl: HTMLElement | null = null;

// ---------------------------------------------------------------------------
// fetchChainDetail — load full session data from server
// ---------------------------------------------------------------------------

async function fetchChainDetail(chainId: string): Promise<ChainDetail | null> {
  try {
    const res = await fetch(`/chain-detail/${encodeURIComponent(chainId)}`);
    if (!res.ok) return null;
    return await res.json() as ChainDetail;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// buildSessionList — renders session rows or empty state (Requirements 16.2, 16.3)
// ---------------------------------------------------------------------------

function buildSessionList(timeline: ChainDetailSession[]): DocumentFragment {
  const frag = document.createDocumentFragment();

  if (timeline.length === 0) {
    frag.appendChild(el('p', { class: 'drawer__empty' }, ['No sessions yet']));
    return frag;
  }

  // Sort descending by index (most recent first)
  const sorted = [...timeline].sort((a, b) => b.index - a.index);

  for (const session of sorted) {
    const ctxPct = session.contextUsagePct;
    const ctxText = ctxPct > 0 ? `ctx ${ctxPct}%` : 'ctx —';

    // Status badge colour
    const statusClass = `drawer__session-status drawer__session-status--${session.status}`;

    const sessionRow = el('div', { class: 'drawer__session' }, [
      el('div', { class: 'drawer__session-header' }, [
        el('span', { class: 'drawer__session-index' }, [`#${session.index}`]),
        el('span', { class: 'drawer__session-date' }, [formatDate(session.date)]),
        el('span', { class: statusClass }, [session.status]),
      ]),
      el('div', { class: 'drawer__session-meta' }, [
        el('span', {}, [`${session.messageCount} msgs`]),
        el('span', { class: ctxPct >= 70 ? 'drawer__ctx--red' : ctxPct >= 50 ? 'drawer__ctx--amber' : '' }, [ctxText]),
        ...(session.topic ? [el('span', { class: 'drawer__session-topic' }, [session.topic])] : []),
      ]),
      ...(session.lastUserMessage ? [
        el('p', { class: 'drawer__session-last-msg' }, [
          el('span', { class: 'drawer__msg-label' }, ['User: ']),
          document.createTextNode(clampText(session.lastUserMessage, 140)) as unknown as HTMLElement,
        ]),
      ] : []),
      ...(session.lastAgentMessage ? [
        el('p', { class: 'drawer__session-agent-msg' }, [
          el('span', { class: 'drawer__msg-label drawer__msg-label--agent' }, ['Agent: ']),
          document.createTextNode(clampText(session.lastAgentMessage, 140)) as unknown as HTMLElement,
        ]),
      ] : []),
    ]);

    frag.appendChild(sessionRow);
  }

  return frag;
}

// ---------------------------------------------------------------------------
// renderDrawerContent — show/hide and populate on drawerChainId change
// ---------------------------------------------------------------------------

function renderDrawerContent(chainId: string | null): void {
  if (!_drawerEl || !_contentEl) return;

  // Remove any existing backdrop
  document.getElementById('drawer-backdrop')?.remove();

  if (chainId === null) {
    _drawerEl.classList.add('drawer--closed');
    _drawerEl.classList.remove('drawer--open');
    return;
  }

  // Add backdrop
  const backdrop = document.createElement('div');
  backdrop.id = 'drawer-backdrop';
  backdrop.className = 'drawer-backdrop';
  backdrop.addEventListener('click', () => setState({ drawerChainId: null }));
  document.body.insertBefore(backdrop, _drawerEl);

  // Open drawer immediately, show loading state
  _drawerEl.classList.remove('drawer--closed');
  _drawerEl.classList.add('drawer--open');
  _contentEl.innerHTML = '';

  // Show chain name from AppState while loading
  const chain = getState().chains.find(c => c.chainId === chainId);
  if (chain) {
    const heading = el('h3', { class: 'drawer__chain-name' }, [chain.displayName]);
    const meta = el('div', { class: 'drawer__chain-meta' }, [
      el('span', {}, [`${chain.sessions?.length ?? 0} sessions`]),
      el('span', {}, [`${chain.totalMessages ?? 0} messages`]),
    ]);
    _contentEl.appendChild(heading);
    _contentEl.appendChild(meta);
    _contentEl.appendChild(el('hr', { class: 'drawer__divider' }));
  }

  const loading = el('p', { class: 'drawer__loading' }, ['Loading sessions…']);
  _contentEl.appendChild(loading);

  // Fetch full detail
  void fetchChainDetail(chainId).then((detail) => {
    if (!_contentEl) return;
    // Check still the same chain
    if (getState().drawerChainId !== chainId) return;

    loading.remove();

    if (!detail) {
      _contentEl.appendChild(el('p', { class: 'drawer__empty' }, ['Failed to load session detail']));
      return;
    }

    _contentEl.appendChild(buildSessionList(detail.timeline));
  });
}

// ---------------------------------------------------------------------------
// initDrawer — mount once from main.ts (Requirement 16.4, 16.5)
// ---------------------------------------------------------------------------

export function initDrawer(): void {
  if (_drawerEl) return;

  const closeBtn = el('button', { class: 'drawer__close', 'aria-label': 'Close' }, ['✕']);
  const contentDiv = el('div', { class: 'drawer__content' });
  const drawer = el('div', { id: 'drawer', class: 'drawer drawer--closed' }, [closeBtn, contentDiv]);

  _drawerEl  = drawer;
  _contentEl = contentDiv;

  document.body.appendChild(drawer);

  closeBtn.addEventListener('click', () => {
    document.getElementById('drawer-backdrop')?.remove();
    setState({ drawerChainId: null });
  });

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && getState().drawerChainId !== null) {
      document.getElementById('drawer-backdrop')?.remove();
      setState({ drawerChainId: null });
    }
  });

  let prevChainId: string | null = getState().drawerChainId;

  subscribe(() => {
    const { drawerChainId } = getState();
    if (drawerChainId !== prevChainId) {
      prevChainId = drawerChainId;
      renderDrawerContent(drawerChainId);
    }
  });

  renderDrawerContent(prevChainId);
}
