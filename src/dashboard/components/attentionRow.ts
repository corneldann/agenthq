// components/attentionRow.ts — attention list row with colour-coded styling and action buttons
// Feature: monitor-dashboard-redesign
// Implements Requirements 6.5, 6.6, 6.7

import { el } from '../utils.js';
import { setState } from '../state.js';
import type { Chain, Job } from '../types.js';

// ---------------------------------------------------------------------------
// Colour variant type
// ---------------------------------------------------------------------------

type AttentionColour = 'amber' | 'blue' | 'red';

// ---------------------------------------------------------------------------
// Button builders
// ---------------------------------------------------------------------------

/** Plain action button with an optional click handler. */
function makeButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = el('button', { class: 'attention-row__btn', type: 'button' }, [label]);
  btn.addEventListener('click', onClick);
  return btn as HTMLButtonElement;
}

/** Link-styled button that navigates to `href`. */
function makeLinkButton(label: string, href: string): HTMLAnchorElement {
  return el('a', { class: 'attention-row__btn attention-row__btn--link', href }, [
    label,
  ]) as HTMLAnchorElement;
}

// ---------------------------------------------------------------------------
// Amber variant — unsummarisedDelta > 0  (Requirement 6.5)
// ---------------------------------------------------------------------------

function buildAmber(chain: Chain): HTMLElement {
  const label = el('span', { class: 'attention-row__label' }, [
    `${chain.displayName} · ${chain.unsummarisedDelta ?? 0} unsummarised`,
  ]);

  const summariseBtn = makeButton('Summarise', () => {
    // Dispatch summarise action — handled by the dashboard page layer
    document.dispatchEvent(
      new CustomEvent('attention:summarise', { detail: { chainId: chain.chainId } }),
    );
  });

  const resumeBtn = makeButton('Resume', () => {
    document.dispatchEvent(
      new CustomEvent('attention:resume', { detail: { chainId: chain.chainId } }),
    );
  });

  const timelineBtn = makeButton('Timeline →', () => {
    setState({ drawerChainId: chain.chainId });
  });

  return el('div', { class: 'attention-row attention-row--amber' }, [
    label,
    el('div', { class: 'attention-row__actions' }, [summariseBtn, resumeBtn, timelineBtn]),
  ]);
}

// ---------------------------------------------------------------------------
// Blue variant — linked job is running  (Requirement 6.6)
// ---------------------------------------------------------------------------

function buildBlue(chain: Chain, runningJob: Job): HTMLElement {
  const label = el('span', { class: 'attention-row__label' }, [
    `${chain.displayName} · ${runningJob.type} running`,
  ]);

  const viewBtn = makeLinkButton('View output →', `/view/${runningJob.id}`);

  return el('div', { class: 'attention-row attention-row--blue' }, [
    label,
    el('div', { class: 'attention-row__actions' }, [viewBtn]),
  ]);
}

// ---------------------------------------------------------------------------
// Red variant — contextUsagePct >= 70  (Requirement 6.7)
// ---------------------------------------------------------------------------

function buildRed(chain: Chain, contextUsagePct: number): HTMLElement {
  const label = el('span', { class: 'attention-row__label' }, [
    `${chain.displayName} · context ${contextUsagePct}%`,
  ]);

  const resumeBtn = makeButton('Resume', () => {
    document.dispatchEvent(
      new CustomEvent('attention:resume', { detail: { chainId: chain.chainId } }),
    );
  });

  return el('div', { class: 'attention-row attention-row--red' }, [
    label,
    el('div', { class: 'attention-row__actions' }, [resumeBtn]),
  ]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * renderAttentionRow — renders a colour-coded row for the Dashboard Attention section.
 *
 * Priority when multiple conditions apply:
 *   1. Blue  — runningJob present with status === 'running'  (Requirement 6.6)
 *   2. Red   — latestSession.contextUsagePct >= 70           (Requirement 6.7)
 *   3. Amber — unsummarisedDelta > 0                         (Requirement 6.5)
 *
 * Returns null when no attention condition is met (caller should omit the row).
 *
 * @param chain      - the Chain record to render
 * @param runningJob - optional running Job linked to this chain
 */
export function renderAttentionRow(
  chain: Chain,
  runningJob?: Job,
): HTMLElement | null {
  // Priority 1 — blue: linked job is running (Requirement 6.6)
  if (runningJob !== undefined && runningJob.status === 'running') {
    return buildBlue(chain, runningJob);
  }

  // Priority 2 — red: context usage >= 70% (Requirement 6.7)
  const contextPct = chain.latestSession?.contextUsagePct ?? null;
  if (contextPct !== null && contextPct >= 70) {
    return buildRed(chain, contextPct);
  }

  // Priority 3 — amber: unsummarised messages (Requirement 6.5)
  if ((chain.unsummarisedDelta ?? 0) > 0) {
    return buildAmber(chain);
  }

  // No condition met — no row to render
  return null;
}

/**
 * attentionColour — derives the colour variant for a chain without building DOM.
 * Useful for unit tests and property tests.
 *
 * @param chain      - the Chain record to evaluate
 * @param runningJob - optional running Job linked to this chain
 * @returns the colour variant, or null if no condition is met
 */
export function attentionColour(
  chain: Chain,
  runningJob?: Job,
): AttentionColour | null {
  if (runningJob !== undefined && runningJob.status === 'running') return 'blue';
  const contextPct = chain.latestSession?.contextUsagePct ?? null;
  if (contextPct !== null && contextPct >= 70) return 'red';
  if ((chain.unsummarisedDelta ?? 0) > 0) return 'amber';
  return null;
}
