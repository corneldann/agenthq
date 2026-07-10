// pages/activity.ts — Activity page renderer
// Feature: monitor-dashboard-redesign
// Implements Requirements 8.1–8.5, 6.6, 6.7

import type { PollLogEntry, SessionState, Chain } from '../types.js';
import { getState, getSelectedWorkspaceId } from '../state.js';
import { el, formatDate, clampText, contextColour } from '../utils.js';

// ---------------------------------------------------------------------------
// Sparkline (Requirement 8.1)
// ---------------------------------------------------------------------------

/** Maps a PollLogEntry type to its CSS modifier (lowercased). */
function sparklineModifier(type: PollLogEntry['type']): string {
  return type.toLowerCase();
}

function buildFullSparkline(pollLog: PollLogEntry[]): HTMLElement {
  const window = pollLog.slice(-Math.min(pollLog.length, 30));
  const maxCount = window.reduce((m, e) => Math.max(m, e.count), 0);

  const bars = window.map((entry) => {
    const bar = el('div', {
      class: `sparkline__bar sparkline__bar--${sparklineModifier(entry.type)}`,
    });
    if (maxCount > 0) {
      bar.style.height = `${(entry.count / maxCount) * 100}%`;
    } else {
      bar.style.height = '4px';
    }
    return bar;
  });

  return el('div', { class: 'sparkline sparkline--full' }, bars);
}

// ---------------------------------------------------------------------------
// Stat cards (Requirement 8.2)
// ---------------------------------------------------------------------------

function buildStatCard(label: string, value: string | number): HTMLElement {
  return el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-card__value' }, [String(value)]),
    el('div', { class: 'stat-card__label' }, [label]),
  ]);
}

function buildStatCards(pollLog: PollLogEntry[]): HTMLElement {
  const crawlCount  = pollLog.filter((e) => e.type === 'CRAWL')
    .reduce((sum, e) => sum + e.count, 0);
  const cloneCount  = pollLog.filter((e) => e.type === 'CLONE')
    .reduce((sum, e) => sum + e.count, 0);
  const promptCount = pollLog.filter((e) => e.type === 'PROMPT')
    .reduce((sum, e) => sum + e.count, 0);
  const pollCycles  = pollLog.length;

  return el('div', { class: 'stat-cards' }, [
    buildStatCard('Crawls',       crawlCount),
    buildStatCard('Clones',       cloneCount),
    buildStatCard('Prompts',      promptCount),
    buildStatCard('Poll cycles',  pollCycles),
  ]);
}

// ---------------------------------------------------------------------------
// Dispatch log table (Requirement 8.3)
// ---------------------------------------------------------------------------

function buildTableRow(entry: PollLogEntry): HTMLElement {
  const timeStr = formatDate(new Date(entry.ts).toISOString());
  return el('tr', {}, [
    el('td', {}, [timeStr]),
    el('td', {}, [entry.type]),
    el('td', {}, [String(entry.count)]),
    el('td', {}, [entry.detail]),
    el('td', {}, [entry.workflowHash]),
  ]);
}

function buildDispatchTable(pollLog: PollLogEntry[]): HTMLElement {
  // 200 most recent, descending by ts
  const rows = pollLog
    .slice()
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 200)
    .map(buildTableRow);

  const thead = el('thead', {}, [
    el('tr', {}, [
      el('th', {}, ['Time']),
      el('th', {}, ['Type']),
      el('th', {}, ['Count']),
      el('th', {}, ['Detail']),
      el('th', {}, ['Workflow']),
    ]),
  ]);

  const tbody = el('tbody', {}, rows);

  return el('table', { class: 'activity-table' }, [thead, tbody]);
}

// ---------------------------------------------------------------------------
// Last poll timestamp (Requirement 8.4)
// ---------------------------------------------------------------------------

function buildLastPoll(pollLog: PollLogEntry[]): HTMLElement {
  const maxTs = pollLog.reduce((m, e) => Math.max(m, e.ts), 0);
  const formatted = formatDate(new Date(maxTs).toISOString());
  return el('p', { class: 'activity__last-poll' }, [`Last poll: ${formatted}`]);
}

// ---------------------------------------------------------------------------
// Sessions table (Requirements 6.6, 6.7)
// ---------------------------------------------------------------------------

/**
 * Maps a SessionState status to a CSS modifier string.
 */
function sessionStatusClass(status: SessionState['status']): string {
  switch (status) {
    case 'active':       return 'session-status--active';
    case 'idle':         return 'session-status--idle';
    case 'rate-limited': return 'session-status--rate-limited';
    case 'complete':     return 'session-status--complete';
    default:             return 'session-status--idle';
  }
}

function buildSessionRow(session: SessionState, chain: Chain): HTMLElement {
  const ctxPct   = session.contextUsagePct ?? 0;
  const colour   = contextColour(ctxPct);
  const lastMsg  = session.lastMessageAt
    ? formatDate(session.lastMessageAt)
    : '—';
  const topic    = clampText(session.topic || chain.displayName || '—', 48);
  const firstMsg = clampText(session.firstUserMessage || '—', 48);

  return el('tr', {}, [
    el('td', {}, [
      el('span', { class: `session-status ${sessionStatusClass(session.status)}` }, [
        session.status,
      ]),
    ]),
    el('td', {}, [topic]),
    el('td', {}, [String(session.messageCount)]),
    el('td', { class: `session-ctx session-ctx--${colour}` }, [`${ctxPct.toFixed(1)}%`]),
    el('td', {}, [lastMsg]),
    el('td', {}, [firstMsg]),
    el('td', { class: 'session-workspace' }, [session.workspaceId || chain.workspaceId || '—']),
  ]);
}

/**
 * Pure function: extracts sessions from chains with a latestSession,
 * applies workspace filter, and sorts by lastMessageAt descending.
 *
 * Exported for testability.
 *
 * Requirement 6.6: when selectedWorkspaceId is a string, only sessions where
 *   chain.workspaceId === selectedWorkspaceId are included.
 * Requirement 6.7: when selectedWorkspaceId is null, all sessions are included.
 */
export function filterSessionsByWorkspace(
  chains: Chain[],
  selectedWorkspaceId: string | null,
): Array<{ session: SessionState; chain: Chain }> {
  return chains
    .filter((c): c is Chain & { latestSession: SessionState } => c.latestSession !== undefined)
    .filter((c) =>
      selectedWorkspaceId === null || c.workspaceId === selectedWorkspaceId,
    )
    .map((c) => ({ session: c.latestSession, chain: c }))
    .sort((a, b) => {
      const ta = a.session.lastMessageAt ? new Date(a.session.lastMessageAt).getTime() : 0;
      const tb = b.session.lastMessageAt ? new Date(b.session.lastMessageAt).getTime() : 0;
      return tb - ta;
    });
}

/**
 * Extracts sessions from chains that have a latestSession, applies workspace
 * filter, and builds a sessions table.
 *
 * Requirement 6.6: when a workspace is selected, filter sessions to that workspace.
 * Requirement 6.7: when "All Workspaces" (null), show all sessions.
 */
function buildSessionsSection(chains: Chain[], selectedWorkspaceId: string | null): HTMLElement {
  // Collect chains that have a latestSession, applying workspace filter
  const filtered = filterSessionsByWorkspace(chains, selectedWorkspaceId);

  const section = el('section', { class: 'activity__sessions-section' });
  section.appendChild(el('h2', { class: 'section-heading' }, ['Sessions']));

  if (filtered.length === 0) {
    section.appendChild(
      el('p', { class: 'activity__empty' }, [
        selectedWorkspaceId !== null
          ? `No sessions found for workspace "${selectedWorkspaceId}".`
          : 'No sessions recorded yet.',
      ]),
    );
    return section;
  }

  // Already sorted by filterSessionsByWorkspace (lastMessageAt desc)
  const rows = filtered.map(({ session, chain }) => buildSessionRow(session, chain));

  const thead = el('thead', {}, [
    el('tr', {}, [
      el('th', {}, ['Status']),
      el('th', {}, ['Topic']),
      el('th', {}, ['Messages']),
      el('th', {}, ['Context %']),
      el('th', {}, ['Last message']),
      el('th', {}, ['First user message']),
      el('th', {}, ['Workspace']),
    ]),
  ]);

  const tbody = el('tbody', {}, rows);
  section.appendChild(el('table', { class: 'activity-table activity-table--sessions' }, [thead, tbody]));

  return section;
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

/**
 * renderActivity — clears `root` and rebuilds all Activity page content
 * from current AppState on every call.
 *
 * Implements Requirements 8.1–8.5, 6.6, 6.7.
 */
export function renderActivity(root: HTMLElement): void {
  const { pollLog, chains } = getState();
  const selectedWorkspaceId = getSelectedWorkspaceId();

  // Clear existing content
  root.innerHTML = '';

  // --- Empty state for poll log (Requirement 8.5) ---
  if (pollLog.length === 0) {
    // Still show sessions section even when no poll cycles exist
    root.appendChild(buildSessionsSection(chains, selectedWorkspaceId));
    root.appendChild(
      el('p', { class: 'activity__empty' }, [
        'No poll cycles recorded yet. The monitor will populate this page as it processes events.',
      ]),
    );
    return;
  }

  // --- Full-width sparkline (Requirement 8.1) ---
  root.appendChild(
    el('section', { class: 'activity__sparkline-section' }, [
      el('h2', { class: 'section-heading' }, ['Activity']),
      buildFullSparkline(pollLog),
    ]),
  );

  // --- Last poll timestamp (Requirement 8.4) ---
  root.appendChild(buildLastPoll(pollLog));

  // --- Stat cards (Requirement 8.2) ---
  root.appendChild(buildStatCards(pollLog));

  // --- Sessions section (Requirements 6.6, 6.7) ---
  // Filter sessions by selected workspace or show all when "All Workspaces" (null).
  root.appendChild(buildSessionsSection(chains, selectedWorkspaceId));

  // --- Dispatch log table (Requirement 8.3) ---
  root.appendChild(
    el('section', { class: 'activity__log-section' }, [
      el('h2', { class: 'section-heading' }, ['Dispatch log']),
      buildDispatchTable(pollLog),
    ]),
  );
}
