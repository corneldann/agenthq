// pages/dashboard.ts — Dashboard page renderer
// Feature: monitor-dashboard-redesign
// Implements Requirements 6.1, 6.2, 6.3, 6.4, 6.8–6.14

import type { Chain, Job, JobChain, PollLogEntry } from '../types.js';
import { getState } from '../state.js';
import { el, formatAge } from '../utils.js';
import { renderAttentionRow } from '../components/attentionRow.js';
import { renderGitSection } from '../components/gitSection.js';

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
 * Implements Requirements 6.1–6.4, 6.8–6.14.
 */
export function renderDashboard(root: HTMLElement): void {
  const state = getState();
  const { chains, jobs, jobChains, pollLog, systemStatus, gitStatus } = state;

  // Clear existing content
  root.innerHTML = '';

  // --- Stat cards (6.1) ---
  const gitAhead = gitStatus?.ahead ?? 0;
  root.appendChild(buildStatCards(chains, jobs, pollLog, gitAhead));

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

  // --- Git section (6.8–6.13) — top of content, before attention ---
  root.appendChild(renderGitSection());

  // --- Attention section (6.3, 6.4) — omitted entirely when no chains qualify ---
  const attentionSection = buildAttentionSection(chains, jobs, jobChains);
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
