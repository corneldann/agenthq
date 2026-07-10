// components/jobCard.ts — standalone JobCard
// Feature: monitor-dashboard-redesign
// Implements Requirements 7.6, 8.8 (display Workspace_Identifier for each queue entry)

import { el, formatDate } from '../utils.js';
import type { JobChain } from '../types.js';
import { attachLogPreview } from './chainCard.js';

// ---------------------------------------------------------------------------
// Status badge colour mapping
// ---------------------------------------------------------------------------

/**
 * Map a JobChain latestStatus to the CSS modifier for the status badge.
 * Requirements 7.6: running=blue, done=green, error=red, reported=amber, other=grey.
 */
function statusBadgeClass(status: string): string {
  switch (status) {
    case 'running':  return 'status-badge--running';
    case 'done':     return 'status-badge--done';
    case 'error':    return 'status-badge--error';
    case 'reported': return 'status-badge--reported';
    default:         return 'status-badge--other';
  }
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/**
 * renderJobCard — renders a standalone JobChain as a card.
 *
 * Card structure:
 *   <article class="job-card">
 *     header row: <h3> name + <span class="status-badge status-badge--{status}">
 *     meta row:   latest timestamp (formatted), run count, last output line
 *     workspace row: workspace identifier badge (when workspaceId is non-empty)
 *     actions row: [Out] button (if mdFile non-empty), [Log] button (if logFile non-empty)
 *
 * Requirements: 7.6, 8.8
 *
 * @param jc - The JobChain record to render.
 * @returns  The completed <article> HTMLElement.
 */
export function renderJobCard(jc: JobChain): HTMLElement {
  const latestRun = jc.runs[jc.runs.length - 1];
  const lastLine  = latestRun?.lastLine ?? '';
  const mdFile    = latestRun?.mdFile ?? '';
  const logFile   = latestRun?.logFile ?? '';

  // -- Header row: name + status badge --
  const badge = el('span', {
    class: `status-badge ${statusBadgeClass(jc.latestStatus)}`,
  }, [jc.latestStatus]);

  const header = el('div', { class: 'job-card__header' }, [
    el('h3', { class: 'job-card__name' }, [jc.jobChain]),
    badge,
  ]);

  // -- Meta row: timestamp, run count, last output line --
  const meta = el('div', { class: 'job-card__meta' }, [
    el('span', { class: 'job-card__timestamp' }, [
      jc.latestTimestamp ? formatDate(jc.latestTimestamp) : '—',
    ]),
    el('span', { class: 'job-card__run-count' }, [
      `${jc.runCount} run${jc.runCount === 1 ? '' : 's'}`,
    ]),
    el('span', { class: 'job-card__last-line' }, [lastLine]),
  ]);

  // -- Log preview toggle: attach to meta row if latest run has a log (Requirement 13.1) --
  if (latestRun?.hasLog === true) {
    attachLogPreview(meta, latestRun.id);
  }

  // -- Workspace identifier badge (Requirement 8.8) --
  // Display the workspace identifier for each queue entry when workspaceId is set.
  const workspaceRow = jc.workspaceId
    ? el('div', { class: 'job-card__workspace' }, [
        el('span', { class: 'job-card__workspace-badge' }, [
          `⊞ ${jc.workspaceId}`,
        ]),
      ])
    : null;

  // -- Actions row: [Out] and [Log] buttons conditionally --
  const actionChildren: (HTMLElement | string)[] = [];

  if (mdFile) {
    const outBtn = el('button', { class: 'job-card__btn job-card__btn--out', type: 'button' }, ['[Out]']);
    outBtn.addEventListener('click', () => {
      window.open(`/view/${encodeURIComponent(mdFile)}`, '_blank');
    });
    actionChildren.push(outBtn);
  }

  if (logFile) {
    const logBtn = el('button', { class: 'job-card__btn job-card__btn--log', type: 'button' }, ['[Log]']);
    logBtn.addEventListener('click', () => {
      window.open(`/view/${encodeURIComponent(logFile)}`, '_blank');
    });
    actionChildren.push(logBtn);
  }

  const actions = el('div', { class: 'job-card__actions' }, actionChildren);

  // -- Assemble card --
  const children: HTMLElement[] = [header, meta];
  if (workspaceRow !== null) children.push(workspaceRow);
  children.push(actions);

  return el('article', { class: 'job-card' }, children);
}
