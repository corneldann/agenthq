// pages/dashboard.ts — Dashboard page renderer
// Feature: multi-workspace-monitoring
// Implements Requirements 6.1, 6.2, 6.3, 6.4, 6.7, 6.8–6.14,
//           7.4, 7.4.1, 7.5, 7.7, 10.1, 10.2, 10.3, 10.4, 10.5,
//           10.5.1, 10.6, 10.6.1, 10.7

import type { Chain, Job, JobChain, PollLogEntry, GitStatus } from '../types.js';
import { getState } from '../state.js';
import { el, formatAge, contextColour } from '../utils.js';
import { renderAttentionRow } from '../components/attentionRow.js';
import { renderGitSection } from '../components/gitSection.js';
import { kebabToTitleCase } from '../components/workspaceFilter.js';
import type { WorkspaceMetrics } from '../types.js';

// ---------------------------------------------------------------------------
// Stat cards (Requirement 6.1)
// ---------------------------------------------------------------------------

function buildStatCard(label: string, value: string | number): HTMLElement {
  const valueEl = el('div', { class: 'stat-card__value' }, [String(value)]);
  const labelEl = el('div', { class: 'stat-card__label' }, [label]);
  return el('div', { class: 'stat-card' }, [valueEl, labelEl]);
}

function buildStatCards(
  chains: Chain[],
  jobs: Job[],
  pollLog: PollLogEntry[],
  gitAhead: number,
): HTMLElement {
  const totalChains = chains.length;
  const runningJobs = jobs.filter((j) => j.status === 'running').length;
  const errorJobs = jobs.filter((j) => j.status === 'error').length;
  const crawlCount = pollLog
    .filter((e) => e.type === 'CRAWL')
    .reduce((sum, e) => sum + e.count, 0);

  return el('div', { class: 'stat-cards' }, [
    buildStatCard('Chains', totalChains),
    buildStatCard('Running', runningJobs),
    buildStatCard('Errors', errorJobs),
    buildStatCard('Crawls', crawlCount),
    buildStatCard('Commits ahead', gitAhead),
  ]);
}

// ---------------------------------------------------------------------------
// Status bar (Requirement 6.2)
// ---------------------------------------------------------------------------

function buildStatusBar(
  lastPollAgo: number | null,
  workflowDirOk: boolean,
  sseClients: number,
  processedCount: number,
): HTMLElement {
  const ageText = lastPollAgo !== null ? formatAge(lastPollAgo) : '—';
  const dirText = workflowDirOk ? 'OK' : 'Error';

  const makeItem = (label: string, value: string | number): HTMLElement =>
    el('div', { class: 'status-bar__item' }, [
      el('span', { class: 'status-bar__label' }, [label + ': ']),
      el('span', { class: 'status-bar__value' }, [String(value)]),
    ]);

  return el('div', { class: 'status-bar' }, [
    makeItem('Last poll', ageText),
    makeItem('Workflow dir', dirText),
    makeItem('SSE clients', sseClients),
    makeItem('Processed', processedCount),
  ]);
}

// ---------------------------------------------------------------------------
// Attention section (Requirements 6.3, 6.4)
// ---------------------------------------------------------------------------

/**
 * Find a running job for a chain by checking AppState.jobs directly
 * (sessionChainId match) and via AppState.jobChains → runs[].
 */
function findRunningJob(chain: Chain, jobs: Job[], jobChains: JobChain[]): Job | undefined {
  // Direct match on AppState.jobs
  const direct = jobs.find(
    (j) => j.sessionChainId === chain.chainId && j.status === 'running',
  );
  if (direct !== undefined) return direct;

  // Via jobChains: find jobChains linked to this chain, then search runs[]
  for (const jc of jobChains) {
    if (jc.sessionChainId !== chain.chainId) continue;
    const inRuns = jc.runs.find((r) => r.status === 'running');
    if (inRuns !== undefined) return inRuns;
  }

  return undefined;
}

/** Returns true when a chain qualifies for the Attention section. */
function chainNeedsAttention(chain: Chain, runningJob: Job | undefined): boolean {
  if ((chain.unsummarisedDelta ?? 0) > 0) return true;
  if (runningJob !== undefined) return true;
  if ((chain.latestSession?.contextUsagePct ?? 0) >= 70) return true;
  return false;
}

function buildAttentionSection(
  chains: Chain[],
  jobs: Job[],
  jobChains: JobChain[],
): HTMLElement | null {
  const rows: HTMLElement[] = [];

  for (const chain of chains) {
    const runningJob = findRunningJob(chain, jobs, jobChains);
    if (!chainNeedsAttention(chain, runningJob)) continue;
    const row = renderAttentionRow(chain, runningJob);
    if (row !== null) rows.push(row);
  }

  if (rows.length === 0) return null;

  const heading = el('h2', { class: 'section-heading' }, ['Attention']);
  return el('section', { class: 'attention-section' }, [heading, ...rows]);
}

// ---------------------------------------------------------------------------
// Workspace metrics computation
// (Requirements 10.1, 10.2, 10.3, 10.4, 10.7)
// ---------------------------------------------------------------------------

/**
 * Computes WorkspaceMetrics for each available workspace from the
 * current chains, jobs and available workspace list.
 */
function computeWorkspaceMetrics(
  chains: Chain[],
  jobs: Job[],
  workspaces: { id: string; displayName: string }[],
): WorkspaceMetrics[] {
  return workspaces.map((ws) => {
    // Filter data for this workspace
    const wsChains = chains.filter((c) => c.workspaceId === ws.id);
    const wsJobs = jobs.filter((j) => j.workspaceId === ws.id);

    // Requirement 10.1: total message count per workspace
    const totalMessages = wsChains.reduce((sum, c) => sum + (c.totalMessages ?? 0), 0);

    // Requirement 10.2: context usage % — average of latest session context pcts
    const sessionsWithContext = wsChains
      .map((c) => c.latestSession?.contextUsagePct ?? null)
      .filter((pct): pct is number => pct !== null);
    const contextUsagePct = sessionsWithContext.length > 0
      ? Math.round(sessionsWithContext.reduce((s, p) => s + p, 0) / sessionsWithContext.length)
      : 0;

    // Requirement 10.3: active session count
    const activeSessions = wsChains.filter(
      (c) => c.latestSession?.status === 'active',
    ).length;

    // Requirement 10.4: pending queue items (jobs with status 'running' or error jobs)
    const pendingQueueItems = wsJobs.filter(
      (j) => j.status === 'running',
    ).length;

    // Requirement 10.7: attention items — unsummarised sessions or queue errors
    const hasUnsummarisedSessions = wsChains.some(
      (c) => (c.unsummarisedDelta ?? 0) > 0,
    );
    const hasQueueErrors = wsJobs.some((j) => j.status === 'error');
    const hasAttentionItems = hasUnsummarisedSessions || hasQueueErrors;

    return {
      workspaceId: ws.id,
      displayName: ws.displayName,
      totalMessages,
      contextUsagePct,
      activeSessions,
      pendingQueueItems,
      hasAttentionItems,
    };
  });
}

// ---------------------------------------------------------------------------
// Workspace comparison table sort
// (Requirements 10.6, 10.6.1)
// ---------------------------------------------------------------------------

/**
 * Sorts workspace metrics by activity level descending.
 * Primary: totalMessages (descending).
 * Secondary: displayName alphabetically (ascending) when messages are equal.
 *
 * Returns a NEW array; original is not mutated.
 */
export function sortWorkspaceMetrics(metrics: WorkspaceMetrics[]): WorkspaceMetrics[] {
  return [...metrics].sort((a, b) => {
    if (b.totalMessages !== a.totalMessages) {
      return b.totalMessages - a.totalMessages; // descending
    }
    // secondary: alphabetical by displayName
    return a.displayName.localeCompare(b.displayName);
  });
}

// ---------------------------------------------------------------------------
// Workspace comparison table
// (Requirements 10.1–10.5, 10.5.1, 10.6, 10.6.1, 10.7)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Builds the workspace comparison table displayed when "All Workspaces" is selected.
 * Requirement 10.5: display comparison table when "All Workspaces" selected.
 */
function buildWorkspaceComparisonTable(metrics: WorkspaceMetrics[]): HTMLElement {
  const sorted = sortWorkspaceMetrics(metrics);

  const wrapper = el('section', { class: 'workspace-comparison' });

  const heading = el('h2', { class: 'section-heading' }, ['Workspace Overview']);
  wrapper.appendChild(heading);

  if (sorted.length === 0) {
    wrapper.appendChild(
      el('p', { class: 'workspace-comparison__empty' }, ['No workspace data available.']),
    );
    return wrapper;
  }

  // Table
  const table = el('table', { class: 'workspace-comparison__table' });

  // Header
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const headers = ['Workspace', 'Messages', 'Context %', 'Active Sessions', 'Queue Items'];
  for (const h of headers) {
    const th = document.createElement('th');
    th.textContent = h;
    th.className = 'workspace-comparison__th';
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement('tbody');
  for (const ws of sorted) {
    const tr = document.createElement('tr');
    tr.className = 'workspace-comparison__row';

    // Highlight rows with attention items (Requirement 10.7)
    if (ws.hasAttentionItems) {
      tr.classList.add('workspace-comparison__row--attention');
    }

    // Workspace name cell with optional attention indicator
    const nameTd = document.createElement('td');
    nameTd.className = 'workspace-comparison__td workspace-comparison__td--name';
    if (ws.hasAttentionItems) {
      const badge = el('span', { class: 'workspace-comparison__attention-badge' }, ['⚠']);
      badge.style.cssText = 'margin-right:6px;color:var(--amber,#f59e0b)';
      nameTd.appendChild(badge);
    }
    nameTd.appendChild(document.createTextNode(ws.displayName));
    tr.appendChild(nameTd);

    // Messages cell
    const msgTd = document.createElement('td');
    msgTd.className = 'workspace-comparison__td workspace-comparison__td--number';
    msgTd.textContent = String(ws.totalMessages);
    tr.appendChild(msgTd);

    // Context % cell with colour coding
    const ctxTd = document.createElement('td');
    ctxTd.className = 'workspace-comparison__td workspace-comparison__td--number';
    const colour = contextColour(ws.contextUsagePct);
    ctxTd.style.color = `var(--${colour}, inherit)`;
    ctxTd.textContent = ws.contextUsagePct > 0 ? `${ws.contextUsagePct}%` : '—';
    tr.appendChild(ctxTd);

    // Active sessions cell
    const sessTd = document.createElement('td');
    sessTd.className = 'workspace-comparison__td workspace-comparison__td--number';
    sessTd.textContent = String(ws.activeSessions);
    tr.appendChild(sessTd);

    // Pending queue items cell
    const queueTd = document.createElement('td');
    queueTd.className = 'workspace-comparison__td workspace-comparison__td--number';
    queueTd.textContent = String(ws.pendingQueueItems);
    tr.appendChild(queueTd);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrapper.appendChild(table);

  return wrapper;
}

// ---------------------------------------------------------------------------
// Multi-workspace git status section
// (Requirements 7.4, 7.4.1, 7.5, 7.7)
// ---------------------------------------------------------------------------

/**
 * Determines which git statuses to display based on the selected workspace.
 *
 * Requirements:
 *   7.4:   When "All Workspaces" selected → display git status for ALL workspaces
 *   7.4.1: If selection state inconsistent → fallback to all workspaces
 *   7.5:   When specific workspace selected → display git status for that workspace only
 *   7.7:   Display Workspace_Identifier alongside each git status block
 */
export function selectGitStatuses(
  gitStatuses: GitStatus[],
  selectedWorkspaceId: string | null,
  availableWorkspaces: { id: string; displayName: string }[],
): { statuses: GitStatus[]; showLabels: boolean } {
  // If no git statuses at all, return empty
  if (gitStatuses.length === 0) {
    return { statuses: [], showLabels: false };
  }

  // Requirement 7.4: "All Workspaces" selected — show all with labels
  if (selectedWorkspaceId === null) {
    return { statuses: gitStatuses, showLabels: true };
  }

  // Requirement 7.5: specific workspace selected — show only that workspace
  const filtered = gitStatuses.filter((g) => g.workspaceId === selectedWorkspaceId);

  // Requirement 7.4.1: Fallback if inconsistent (selected ID not in available workspaces)
  const knownIds = availableWorkspaces.map((w) => w.id);
  const selectionIsValid = knownIds.includes(selectedWorkspaceId);
  if (!selectionIsValid || filtered.length === 0) {
    // Fallback to all workspaces
    return { statuses: gitStatuses, showLabels: true };
  }

  return { statuses: filtered, showLabels: filtered.length > 1 };
}

/**
 * Renders a single git status mini-block showing branch + dirty summary.
 * Used when displaying all workspace git statuses in a compact view.
 */
function buildGitStatusBlock(gitStatus: GitStatus, label: string | null): HTMLElement {
  const block = el('div', { class: 'git-status-block' });
  block.style.cssText = [
    'padding:8px 12px',
    'border:1px solid var(--border,#2a2d3e)',
    'border-radius:6px',
    'background:var(--surface,#1a1d27)',
    'font-family:ui-monospace,SFMono-Regular,Consolas,monospace',
    'font-size:12px',
  ].join(';');

  // Workspace label (Requirement 7.7)
  if (label !== null) {
    const labelEl = el('div', { class: 'git-status-block__label' }, [label]);
    labelEl.style.cssText = 'font-size:11px;font-weight:600;color:var(--accent,#3b82f6);margin-bottom:4px';
    block.appendChild(labelEl);
  }

  // Branch + status line
  const statusLine = el('div', { class: 'git-status-block__status' });
  statusLine.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';

  // Branch
  const branchEl = el('span', { class: 'git-status-block__branch' });
  branchEl.textContent = `⎇ ${gitStatus.branch}`;
  branchEl.style.cssText = 'color:var(--text,#e2e8f0)';
  statusLine.appendChild(branchEl);

  // Clean / dirty indicator
  if (gitStatus.clean) {
    const cleanEl = el('span', {}, ['✓ clean']);
    cleanEl.style.color = 'var(--green,#22c55e)';
    statusLine.appendChild(cleanEl);
  } else {
    // Count changed files
    const changedCount = gitStatus.staged.length + gitStatus.modified.length + gitStatus.untracked.length;
    const dirtyEl = el('span', {}, [`${changedCount} change${changedCount !== 1 ? 's' : ''}`]);
    dirtyEl.style.color = 'var(--amber,#f59e0b)';
    statusLine.appendChild(dirtyEl);
  }

  // Ahead/behind indicators
  if (gitStatus.ahead > 0 || gitStatus.behind > 0) {
    const parts: string[] = [];
    if (gitStatus.ahead > 0) parts.push(`↑${gitStatus.ahead}`);
    if (gitStatus.behind > 0) parts.push(`↓${gitStatus.behind}`);
    const syncEl = el('span', {}, [parts.join(' ')]);
    syncEl.style.color = 'var(--muted,#6b7280)';
    statusLine.appendChild(syncEl);
  }

  block.appendChild(statusLine);
  return block;
}

/**
 * Renders a multi-workspace git status panel showing compact blocks for each workspace.
 * This is the "All Workspaces" view — each block has a workspace label.
 * (Requirements 7.4, 7.7)
 */
function buildMultiWorkspaceGitSection(
  statuses: GitStatus[],
  showLabels: boolean,
  availableWorkspaces: { id: string; displayName: string }[],
): HTMLElement {
  const section = el('section', { class: 'git-status-multi' });
  section.style.cssText = [
    'display:grid',
    'grid-template-columns:repeat(auto-fill,minmax(200px,1fr))',
    'gap:8px',
    'margin-bottom:12px',
  ].join(';');

  for (const gs of statuses) {
    const ws = availableWorkspaces.find((w) => w.id === gs.workspaceId);
    const label = showLabels
      ? (ws?.displayName ?? kebabToTitleCase(gs.workspaceId))
      : null;
    section.appendChild(buildGitStatusBlock(gs, label));
  }

  return section;
}

// ---------------------------------------------------------------------------
// Activity sparkline (Requirement 6.14)
// ---------------------------------------------------------------------------

/** Maps a PollLogEntry type to a CSS modifier for the sparkline bar. */
function sparklineModifier(type: PollLogEntry['type']): string {
  switch (type) {
    case 'CRAWL':  return 'crawl';   // green
    case 'CLONE':  return 'clone';   // blue
    case 'PROMPT': return 'prompt';  // purple
    case 'poll':   return 'poll';    // grey
    default:       return 'poll';
  }
}

function buildSparkline(pollLog: PollLogEntry[]): HTMLElement {
  // Take the last 30 entries (most recent)
  const window = pollLog.slice(-30);
  const maxCount = window.reduce((m, e) => Math.max(m, e.count), 0);

  const bars = window.map((entry) => {
    const heightPct = maxCount > 0 ? (entry.count / maxCount) * 100 : 0;
    const bar = el('div', {
      class: `sparkline__bar sparkline__bar--${sparklineModifier(entry.type)}`,
    });
    bar.style.height = `${heightPct}%`;
    return bar;
  });

  return el('div', { class: 'sparkline' }, bars);
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

/**
 * renderDashboard — clears `root` and rebuilds all Dashboard content from
 * current AppState on every call.
 *
 * Implements Requirements 6.1–6.4, 6.7, 6.8–6.14,
 *   7.4, 7.4.1, 7.5, 7.7, 10.1–10.7.
 */
export function renderDashboard(root: HTMLElement): void {
  const state = getState();
  const { chains, jobs, jobChains, pollLog, systemStatus, gitStatus, gitStatuses, workspaceFilter } = state;

  const { selectedWorkspaceId, availableWorkspaces } = workspaceFilter;
  const isAllWorkspaces = selectedWorkspaceId === null;

  // Filter chains and jobs by selected workspace
  const filteredChains = isAllWorkspaces
    ? chains
    : chains.filter((c) => c.workspaceId === selectedWorkspaceId);
  const filteredJobs = isAllWorkspaces
    ? jobs
    : jobs.filter((j) => j.workspaceId === selectedWorkspaceId);

  // Clear existing content
  root.innerHTML = '';

  // --- Stat cards (6.1) — based on filtered data ---
  // For "ahead" count: use max across all shown git statuses
  const activeGitStatuses = isAllWorkspaces
    ? gitStatuses
    : gitStatuses.filter((g) => g.workspaceId === selectedWorkspaceId);
  const gitAhead = activeGitStatuses.length > 0
    ? activeGitStatuses.reduce((sum, g) => sum + g.ahead, 0)
    : (gitStatus?.ahead ?? 0);
  root.appendChild(buildStatCards(filteredChains, filteredJobs, pollLog, gitAhead));

  // --- Status bar (6.2) ---
  if (systemStatus !== null) {
    root.appendChild(
      buildStatusBar(
        systemStatus.lastPollAgo,
        systemStatus.workflowDirOk,
        systemStatus.sseClients,
        systemStatus.processedCount,
      ),
    );
  }

  // --- Workspace comparison table (10.5) — only when "All Workspaces" selected ---
  if (isAllWorkspaces && availableWorkspaces.length > 1) {
    const metrics = computeWorkspaceMetrics(chains, jobs, availableWorkspaces);
    root.appendChild(buildWorkspaceComparisonTable(metrics));
  }

  // --- Git status section ---
  // Multi-workspace compact view OR the full interactive single-workspace view
  if (gitStatuses.length > 0) {
    const { statuses, showLabels } = selectGitStatuses(
      gitStatuses,
      selectedWorkspaceId,
      availableWorkspaces,
    );

    if (isAllWorkspaces && gitStatuses.length > 1) {
      // Requirements 7.4, 7.7: compact multi-workspace blocks with labels
      const multiGitSection = el('section', { class: 'git-status-section' });
      const heading = el('h2', { class: 'section-heading' }, ['Git Status']);
      multiGitSection.appendChild(heading);
      multiGitSection.appendChild(
        buildMultiWorkspaceGitSection(statuses, showLabels, availableWorkspaces),
      );
      root.appendChild(multiGitSection);
    } else {
      // Requirement 7.5 / 10.5.1: single workspace — show full interactive git section
      root.appendChild(renderGitSection());
    }
  } else {
    // Legacy single-workspace or no git data: show full interactive git section
    root.appendChild(renderGitSection());
  }

  // --- Attention section (6.3, 6.4) — omitted entirely when no chains qualify ---
  const attentionSection = buildAttentionSection(filteredChains, filteredJobs, jobChains);
  if (attentionSection !== null) {
    root.appendChild(attentionSection);
  }

  // --- Activity sparkline (6.14) ---
  if (pollLog.length > 0) {
    const sparklineWrap = el('section', { class: 'sparkline-section' }, [
      el('h2', { class: 'section-heading' }, ['Activity']),
      buildSparkline(pollLog),
    ]);
    root.appendChild(sparklineWrap);
  }
}
