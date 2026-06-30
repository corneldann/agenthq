// pages/activity.ts — Activity page renderer
// Feature: monitor-dashboard-redesign
// Implements Requirements 8.1–8.5

import type { PollLogEntry } from '../types.js';
import { getState } from '../state.js';
import { el, formatDate } from '../utils.js';

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
// Main render function
// ---------------------------------------------------------------------------

/**
 * renderActivity — clears `root` and rebuilds all Activity page content
 * from current AppState on every call.
 *
 * Implements Requirements 8.1–8.5.
 */
export function renderActivity(root: HTMLElement): void {
  const { pollLog } = getState();

  // Clear existing content
  root.innerHTML = '';

  // --- Empty state (Requirement 8.5) ---
  if (pollLog.length === 0) {
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

  // --- Dispatch log table (Requirement 8.3) ---
  root.appendChild(
    el('section', { class: 'activity__log-section' }, [
      el('h2', { class: 'section-heading' }, ['Dispatch log']),
      buildDispatchTable(pollLog),
    ]),
  );
}
