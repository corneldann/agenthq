// pages/work.ts — Work page renderer
// Feature: monitor-dashboard-redesign
// Requirements 7.1–7.11

import { el } from '../utils.js';
import { getState } from '../state.js';
import type { Chain, JobChain, Job } from '../types.js';
import { renderChainCard } from '../components/chainCard.js';
import { renderJobCard } from '../components/jobCard.js';

// ---------------------------------------------------------------------------
// Module-level filter/sort state — preserved across re-renders (Req 7.7, 7.8)
// ---------------------------------------------------------------------------

let filterText   = '';
let sortKey      = 'lastActive';   // 'lastActive' | 'nameAsc' | 'nameDesc' | 'status'
let hideTrivial  = false;

// ---------------------------------------------------------------------------
// Sorting helpers
// ---------------------------------------------------------------------------

type SortKey = 'lastActive' | 'nameAsc' | 'nameDesc' | 'status';

function compareChains(a: Chain, b: Chain, key: SortKey): number {
  switch (key) {
    case 'nameAsc':
      return a.displayName.localeCompare(b.displayName);
    case 'nameDesc':
      return b.displayName.localeCompare(a.displayName);
    case 'status':
      return (a.overallStatus ?? '').localeCompare(b.overallStatus ?? '');
    case 'lastActive':
    default:
      return new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime();
  }
}

function compareJobChains(a: JobChain, b: JobChain, key: SortKey): number {
  switch (key) {
    case 'nameAsc':
      return a.jobChain.localeCompare(b.jobChain);
    case 'nameDesc':
      return b.jobChain.localeCompare(a.jobChain);
    case 'status':
      return a.latestStatus.localeCompare(b.latestStatus);
    case 'lastActive':
    default:
      return new Date(b.latestTimestamp).getTime() - new Date(a.latestTimestamp).getTime();
  }
}

// ---------------------------------------------------------------------------
// Filter helpers (Requirements 7.7)
// ---------------------------------------------------------------------------

/**
 * Returns true if a chain (with its linked job chains) matches the filter text.
 * Case-insensitive containment on chain displayName OR any linked JobChain name.
 */
export function chainMatchesFilter(chain: Chain, linkedJobChains: JobChain[], text: string): boolean {
  if (!text) return true;
  const lower = text.toLowerCase();
  if (chain.displayName.toLowerCase().includes(lower)) return true;
  return linkedJobChains.some(jc => jc.jobChain.toLowerCase().includes(lower));
}

/**
 * Returns true if a standalone JobChain matches the filter text.
 */
export function jobChainMatchesFilter(jc: JobChain, text: string): boolean {
  if (!text) return true;
  return jc.jobChain.toLowerCase().includes(text.toLowerCase());
}

/**
 * Returns true if a chain should be hidden when hideTrivial is active.
 * Requirement 7.8: hide when overallStatus === 'complete' and no running jobs.
 */
function isChainTrivial(chain: Chain, linkedJobChains: JobChain[]): boolean {
  if (chain.overallStatus !== 'complete') return false;
  return !linkedJobChains.some(jc => jc.latestStatus === 'running');
}

// ---------------------------------------------------------------------------
// Controls builder (Requirements 7.7, 7.8)
// ---------------------------------------------------------------------------

/**
 * Build the filter/sort/hide-trivial control bar.
 * Calls onUpdate() whenever any control changes so the caller can re-render.
 */
function buildControls(onUpdate: () => void): HTMLElement {
  const filterInput = el('input', {
    type:        'text',
    class:       'work-controls__filter',
    placeholder: 'Filter by name…',
    value:       filterText,
  });
  filterInput.addEventListener('input', () => {
    filterText = (filterInput as HTMLInputElement).value;
    onUpdate();
  });

  const sortSelect = el('select', { class: 'work-controls__sort' });
  const sortOptions: Array<{ value: SortKey; label: string }> = [
    { value: 'lastActive', label: 'Last active' },
    { value: 'nameAsc',    label: 'Name A–Z'    },
    { value: 'nameDesc',   label: 'Name Z–A'    },
    { value: 'status',     label: 'Status'      },
  ];
  for (const opt of sortOptions) {
    const optEl = el('option', { value: opt.value }, [opt.label]);
    if (opt.value === sortKey) optEl.setAttribute('selected', 'selected');
    sortSelect.appendChild(optEl);
  }
  sortSelect.addEventListener('change', () => {
    sortKey = (sortSelect as HTMLSelectElement).value as SortKey;
    onUpdate();
  });

  const trivialLabel = el('label', { class: 'work-controls__hide-trivial-label' });
  const trivialCheck = el('input', {
    type:  'checkbox',
    class: 'work-controls__hide-trivial',
  });
  if (hideTrivial) trivialCheck.setAttribute('checked', 'checked');
  trivialCheck.addEventListener('change', () => {
    hideTrivial = (trivialCheck as HTMLInputElement).checked;
    onUpdate();
  });
  trivialLabel.appendChild(trivialCheck);
  trivialLabel.appendChild(document.createTextNode(' Hide trivial'));

  return el('div', { class: 'work-controls' }, [
    filterInput,
    sortSelect,
    trivialLabel,
  ]);
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

/**
 * Builds the SESSION CHAINS section (Requirements 7.2, 7.4, 7.10).
 * Returns the section element; applies CSS display:none on hidden items.
 */
function buildSessionChainsSection(
  sessionChains: Chain[],
  jobsByChainId: Map<string, Job[]>,
): HTMLElement {
  const section = el('section', { class: 'work-section work-section--session-chains' });
  section.appendChild(el('h2', { class: 'work-section__heading' }, ['SESSION CHAINS']));

  const sorted = [...sessionChains].sort((a, b) => compareChains(a, b, sortKey as SortKey));

  let visibleCount = 0;

  for (const chain of sorted) {
    const linked = jobsByChainId.get(chain.chainId) ?? [];
    // For filter matching use job names
    const linkedNames = linked.map(j => ({ jobChain: j.name } as JobChain));
    const card = renderChainCard(chain, linked);

    const hidden =
      !chainMatchesFilter(chain, linkedNames, filterText) ||
      (hideTrivial && isChainTrivial(chain, []));

    if (hidden) {
      card.style.display = 'none';
    } else {
      visibleCount++;
    }

    section.appendChild(card);
  }

  if (sessionChains.length === 0 || visibleCount === 0) {
    section.appendChild(el('p', { class: 'work-section__empty' }, [
      'Start a Kiro session to see it appear here',
    ]));
  }

  return section;
}

/**
 * Builds the STANDALONE JOBS section (Requirements 7.3, 7.6, 7.11).
 * Returns the section element; applies CSS display:none on hidden items.
 */
function buildStandaloneJobsSection(standaloneJobs: JobChain[]): HTMLElement {
  const section = el('section', { class: 'work-section work-section--standalone-jobs' });
  section.appendChild(el('h2', { class: 'work-section__heading' }, ['STANDALONE JOBS']));

  const sorted = [...standaloneJobs].sort((a, b) =>
    compareJobChains(a, b, sortKey as SortKey),
  );

  let visibleCount = 0;

  for (const jc of sorted) {
    const card   = renderJobCard(jc);
    const hidden = !jobChainMatchesFilter(jc, filterText);

    if (hidden) {
      card.style.display = 'none';
    } else {
      visibleCount++;
    }

    section.appendChild(card);
  }

  if (standaloneJobs.length === 0 || visibleCount === 0) {
    const empty = el('p', { class: 'work-section__empty' }, [
      'No standalone jobs are currently running',
    ]);
    section.appendChild(empty);
  }

  return section;
}

/**
 * Builds the UNKNOWN / STUBS accordion (Requirement 7.1).
 *
 * Contains:
 *   - Chains that have NO linked JobChains
 *   - JobChains whose sessionChainId is non-empty but doesn't match any known chain
 *
 * Rendered as a collapsed <details> element.
 */
function buildUnknownSection(
  orphanChains: Chain[],
  orphanJobChains: JobChain[],
): HTMLElement {
  const details  = el('details', { class: 'work-section work-section--unknown' });
  const summary  = el('summary', { class: 'work-section__heading work-section__heading--summary' }, [
    'UNKNOWN / STUBS',
  ]);
  details.appendChild(summary);

  if (orphanChains.length === 0 && orphanJobChains.length === 0) {
    details.appendChild(el('p', { class: 'work-section__empty' }, ['Nothing here.']));
    return details;
  }

  for (const chain of orphanChains) {
    const card = el('div', { class: 'work-unknown__chain-stub' }, [
      el('span', { class: 'work-unknown__name' }, [chain.displayName]),
      el('span', { class: 'work-unknown__id' },   [chain.chainId]),
    ]);
    details.appendChild(card);
  }

  for (const jc of orphanJobChains) {
    const card = el('div', { class: 'work-unknown__job-stub' }, [
      el('span', { class: 'work-unknown__name' }, [jc.jobChain]),
      el('span', { class: 'work-unknown__id' },   [jc.sessionChainId]),
    ]);
    details.appendChild(card);
  }

  return details;
}

// ---------------------------------------------------------------------------
// Main export (Requirement 7.1–7.11)
// ---------------------------------------------------------------------------

/**
 * renderWork — clears `root` and re-builds the entire Work page from current AppState.
 *
 * Re-render is triggered by the main.ts subscriber on every state change.
 * Filter text, sort key, and hide-trivial flag are module-level and survive re-renders.
 *
 * @param root - The container HTMLElement to render into.
 */
export function renderWork(root: HTMLElement): void {
  const { chains, jobChains, jobs } = getState();

  // ── Build index: chainId → individual Jobs (all types, for chain card panel) ──
  const jobsByChainId = new Map<string, import('../types.js').Job[]>();
  for (const job of jobs) {
    if (job.sessionChainId) {
      const arr = jobsByChainId.get(job.sessionChainId) ?? [];
      arr.push(job);
      jobsByChainId.set(job.sessionChainId, arr);
    }
  }

  // ── Build index: chainId → linked JobChains (for classification + standalone) ──
  const jobChainsByChainId = new Map<string, JobChain[]>();
  for (const jc of jobChains) {
    if (jc.sessionChainId) {
      const arr = jobChainsByChainId.get(jc.sessionChainId) ?? [];
      arr.push(jc);
      jobChainsByChainId.set(jc.sessionChainId, arr);
    }
  }

  // ── Classify records ──────────────────────────────────────────────────────
  // SESSION CHAINS: spec umbrella chains, chains with linked jobs, or chains with meaningful content
  // Exclude: absorbed sub-chains (specChainId set)
  const isUUID = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const isMeaningful = (c: Chain) => {
    if ((c.sessions?.length ?? 0) > 1) return true;
    if ((c.totalMessages ?? 0) > 20) return true;
    if ((c.workflowCount ?? 0) > 1) return true;
    return false;
  };

  const sessionChains = chains.filter(c => {
    if (c.specChainId) return false;
    const hasJobs = (jobsByChainId.get(c.chainId)?.length ?? 0) > 0;
    const isSpecChain = isUUID(c.chainId);
    return hasJobs || isSpecChain || isMeaningful(c);
  });

  const orphanChains = chains.filter(c => {
    if (c.specChainId) return false;
    const hasJobs = (jobsByChainId.get(c.chainId)?.length ?? 0) > 0;
    const isSpecChain = isUUID(c.chainId);
    return !hasJobs && !isSpecChain && !isMeaningful(c);
  });

  // STANDALONE JOBS: JobChains with empty sessionChainId
  const standaloneJobs = jobChains.filter(jc => jc.sessionChainId === '');

  // ORPHAN JOB CHAINS: non-empty sessionChainId that doesn't match any chain
  const knownChainIds = new Set(chains.map(c => c.chainId));
  const orphanJobChains = jobChains.filter(
    jc => jc.sessionChainId !== '' && !knownChainIds.has(jc.sessionChainId),
  );

  root.textContent = '';

  const controls = buildControls(() => renderWork(root));
  root.appendChild(controls);

  root.appendChild(buildSessionChainsSection(sessionChains, jobsByChainId));
  root.appendChild(buildStandaloneJobsSection(standaloneJobs));
  root.appendChild(buildUnknownSection(orphanChains, orphanJobChains));
}
