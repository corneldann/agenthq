// components/chainCard.ts — ChainCard with ContextRing, JOBS summary panel, RunTimeline, action buttons
// Feature: monitor-dashboard-redesign

import { el, formatDate, clampText, contextColour, statusToClass, sortRunsByTimestamp } from '../utils.js';
import type { Job, Chain, SessionState } from '../types.js';
import { setState } from '../state.js';

// ---------------------------------------------------------------------------
// RunTimeline (Requirements 15.1–15.5)
// ---------------------------------------------------------------------------

/** Module-level closure tracking which run dot is currently expanded. */
let expandedRunId: string | null = null;

// (statusToClass is exported from ../utils.js — Requirement 15.2)

/**
 * Build the inline detail panel for a single run.
 * Requirements 15.3: id, status, timestamp (formatted), line count, last output line.
 */
function buildDetail(run: Job): HTMLElement {
  return el('div', { class: 'run-detail' }, [
    el('dl', { class: 'run-detail__fields' }, [
      el('dt', {}, ['Run ID']),
      el('dd', {}, [run.id]),
      el('dt', {}, ['Status']),
      el('dd', {}, [run.status]),
      el('dt', {}, ['Timestamp']),
      el('dd', {}, [formatDate(run.timestamp)]),
      el('dt', {}, ['Lines']),
      el('dd', {}, [String(run.lines)]),
      el('dt', {}, ['Last output']),
      el('dd', { class: 'run-detail__last-line' }, [run.lastLine ?? '']),
    ]),
  ]);
}

/**
 * renderRunTimeline — renders a horizontal dot-per-run sequence.
 *
 * Requirements 15.1: dots sorted ascending by timestamp.
 * Requirements 15.2: dot colours by status.
 * Requirements 15.3: click/keyboard expands inline detail below timeline.
 * Requirements 15.4: clicking an already-expanded dot collapses it.
 * Requirements 15.5: empty runs[] → "No runs yet" placeholder.
 *
 * @param runs - array of Job objects for this job-chain's run history
 * @returns a `<div class="run-timeline">` element
 */
export function renderRunTimeline(runs: Job[]): HTMLElement {
  // Requirement 15.5 — empty state
  if (runs.length === 0) {
    return el('div', { class: 'run-timeline run-timeline--empty' }, [
      el('span', {}, ['No runs yet']),
    ]);
  }

  // Requirement 15.1 — sort ascending by timestamp
  const sorted = sortRunsByTimestamp(runs);

  // Container holds both the dots row and any open detail panel
  const container = el('div', { class: 'run-timeline' });
  const dotsRow   = el('div', { class: 'run-timeline__dots' });
  container.appendChild(dotsRow);

  // Detail slot — replaced when a different dot is expanded
  let detailSlot: HTMLElement | null = null;

  /**
   * Toggle-expand handler shared by all dots.
   * Requirement 15.3 / 15.4 — activating the already-expanded dot collapses it.
   */
  function handleActivate(run: Job): void {
    // Remove existing detail panel (if any)
    if (detailSlot) {
      detailSlot.remove();
      detailSlot = null;
    }

    if (expandedRunId === run.id) {
      // Already expanded → collapse (Requirement 15.4)
      expandedRunId = null;
    } else {
      // Expand selected run
      expandedRunId = run.id;
      detailSlot = buildDetail(run);
      container.appendChild(detailSlot);
    }

    // Sync aria-expanded on all dots
    const allDots = dotsRow.querySelectorAll<HTMLButtonElement>('.run-dot');
    allDots.forEach((btn) => {
      const isExpanded = btn.dataset['runId'] === expandedRunId;
      btn.setAttribute('aria-expanded', String(isExpanded));
    });
  }

  // Build one dot button per run
  for (const run of sorted) {
    const dotClass  = statusToClass(run.status);
    const isExpanded = expandedRunId === run.id;

    // Requirement 15.2 — visual circle inside the button
    const circle = el('span', { class: 'run-dot__circle', 'aria-hidden': 'true' });

    // Native <button> handles keyboard Enter/Space automatically (Requirement 15.3)
    const btn = el(
      'button',
      {
        class:          `run-dot ${dotClass}`,
        tabindex:       '0',
        'aria-label':   `Run ${run.id}`,
        'aria-expanded': String(isExpanded),
        'data-run-id':  run.id,
      },
      [circle],
    );

    // Attach click handler (keyboard is handled natively by button)
    btn.addEventListener('click', () => handleActivate(run));

    dotsRow.appendChild(btn);
  }

  // If a run was already expanded before re-render, restore its detail panel
  if (expandedRunId !== null) {
    const activeRun = sorted.find((r) => r.id === expandedRunId);
    if (activeRun) {
      detailSlot = buildDetail(activeRun);
      container.appendChild(detailSlot);
    } else {
      // Run no longer present — clear stale state
      expandedRunId = null;
    }
  }

  return container;
}

// ---------------------------------------------------------------------------
// ContextRing (Requirements 14.1–14.5)
// ---------------------------------------------------------------------------

/** Maps contextColour token to hex stroke colour. */
const COLOUR_HEX: Record<'green' | 'amber' | 'red' | 'grey', string> = {
  green: '#22c55e',
  amber: '#f59e0b',
  red:   '#ef4444',
  grey:  '#d1d5db',
};

const RING_RADIUS      = 12;
const RING_CX          = 14;
const RING_CY          = 14;
const RING_STROKE_W    = 3;
const CIRCUMFERENCE    = 2 * Math.PI * RING_RADIUS; // ≈ 75.398
const SVG_NS           = 'http://www.w3.org/2000/svg';

/**
 * renderContextRing — renders a 28 px SVG arc gauge for context usage.
 *
 * Requirements 14.1: 28 px SVG arc gauge; filled arc = contextUsagePct / 100 * circumference.
 * Requirements 14.2: green  when pct < 50.
 * Requirements 14.3: amber  when 50 ≤ pct < 70.
 * Requirements 14.4: red + pulse animation when pct ≥ 70.
 * Requirements 14.5: neutral grey / zero fill when latestSession absent or pct out of 0–100.
 *
 * @param latestSession - the chain's latest SessionState, or undefined
 * @returns a `<svg>` element (28×28) displaying the context ring
 */
export function renderContextRing(latestSession: SessionState | undefined): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('width',   '28');
  svg.setAttribute('height',  '28');
  svg.setAttribute('viewBox', '0 0 28 28');

  // Determine validity and fill amount
  const pct  = latestSession?.contextUsagePct;
  const valid = pct !== undefined && pct >= 0 && pct <= 100;
  const fill  = valid ? (pct! / 100) * CIRCUMFERENCE : 0;
  const token = valid ? contextColour(pct!) : 'grey';
  const arcHex = COLOUR_HEX[token];

  // Pulse class when red (pct ≥ 70) — Requirement 14.4
  if (valid && token === 'red') {
    svg.classList.add('context-ring--pulse');
  }

  // Track circle (background grey arc)
  const track = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('cx',           String(RING_CX));
  track.setAttribute('cy',           String(RING_CY));
  track.setAttribute('r',            String(RING_RADIUS));
  track.setAttribute('fill',         'none');
  track.setAttribute('stroke',       '#d1d5db');
  track.setAttribute('stroke-width', String(RING_STROKE_W));
  track.setAttribute('stroke-dasharray', String(CIRCUMFERENCE));
  svg.appendChild(track);

  // Arc circle (filled portion)
  const arc = document.createElementNS(SVG_NS, 'circle');
  arc.setAttribute('cx',              String(RING_CX));
  arc.setAttribute('cy',              String(RING_CY));
  arc.setAttribute('r',               String(RING_RADIUS));
  arc.setAttribute('fill',            'none');
  arc.setAttribute('stroke',          arcHex);
  arc.setAttribute('stroke-width',    String(RING_STROKE_W));
  arc.setAttribute('stroke-dasharray', `${fill} ${CIRCUMFERENCE - fill}`);
  arc.setAttribute('transform',       `rotate(-90 ${RING_CX} ${RING_CY})`);
  svg.appendChild(arc);

  return svg;
}

// ---------------------------------------------------------------------------
// renderJobsSummaryPanel (chain card right column)
// Shows total job count, breakdown by type, latest timestamp per type.
// Clicking the header expands to a full scrollable job list.
// ---------------------------------------------------------------------------

/** Emoji/icon per job type for quick visual scanning */
function typeIcon(type: string): string {
  switch (type) {
    case 'crawl':          return '↓';
    case 'clone':          return '⎇';
    case 'session-summary':
    case 'summarise':      return '∑';
    case 'file-edit':      return '✎';
    case 'analysis':
    case 'large-analysis': return '◎';
    case 'kiro-mcp':       return '⚙';
    case 'research':       return '⌕';
    default:               return '●';
  }
}

function jobStatusDot(status: string): HTMLElement {
  const dot = el('span', { class: `job-status-dot job-status-dot--${status}` }, ['']);
  return dot;
}

/**
 * renderJobsSummaryPanel — right column of a chain card showing jobs.
 *
 * Summary row: "N jobs · crawl×5 · clone×2 · prompt×3"
 * Clicking expands to full list sorted by timestamp desc.
 */
export function renderJobsSummaryPanel(jobs: Job[]): HTMLElement {
  const panel = el('div', { class: 'chain-card__jobs-panel' });

  if (jobs.length === 0) {
    panel.appendChild(el('span', { class: 'chain-card__jobs-empty' }, ['No jobs']));
    return panel;
  }

  // Count by type
  const counts = new Map<string, number>();
  for (const j of jobs) {
    const t = j.type || 'other';
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }

  // Sort jobs by timestamp desc
  const sorted = [...jobs].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const latest = sorted[0];

  // ── Summary header (always visible, clickable) ────────────────────────
  const typeChips = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) =>
      el('span', { class: 'chain-card__job-chip' }, [
        el('span', { class: 'chain-card__job-chip-icon' }, [typeIcon(type)]),
        el('span', { class: 'chain-card__job-chip-label' }, [type]),
        el('span', { class: 'chain-card__job-chip-count' }, [`×${count}`]),
      ])
    );

  const totalEl = el('span', { class: 'chain-card__jobs-total' }, [`${jobs.length} job${jobs.length !== 1 ? 's' : ''}`]);
  const toggleIcon = el('span', { class: 'chain-card__jobs-toggle-icon' }, ['▸']);

  const summaryRow = el('div', { class: 'chain-card__jobs-summary' }, [
    toggleIcon,
    totalEl,
    ...typeChips,
  ]);

  panel.appendChild(summaryRow);

  // ── Latest job preview (always visible) ──────────────────────────────
  const previewEl = el('div', { class: 'chain-card__jobs-preview' }, [
    jobStatusDot(latest.status),
    el('span', { class: 'chain-card__jobs-preview-name' }, [latest.name]),
    el('span', { class: 'chain-card__jobs-preview-ts' }, [formatDate(latest.timestamp)]),
  ]);
  panel.appendChild(previewEl);

  // ── Expandable full list ──────────────────────────────────────────────
  let expanded = false;
  const listEl = el('div', { class: 'chain-card__jobs-list chain-card__jobs-list--hidden' });

  for (const job of sorted) {
    const outBtn = job.mdFile
      ? el('button', { class: 'chain-card__job-btn', type: 'button' }, ['Out'])
      : null;
    if (outBtn) outBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(`/view/${job.mdFile}`, '_blank');
    });

    const logBtn = job.hasLog && job.logFile
      ? el('button', { class: 'chain-card__job-btn', type: 'button' }, ['Log'])
      : null;
    if (logBtn) logBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(`/view/${job.logFile}`, '_blank');
    });

    const btns = [outBtn, logBtn].filter(Boolean) as HTMLElement[];

    const row = el('div', { class: 'chain-card__job-row' }, [
      jobStatusDot(job.status),
      el('span', { class: 'chain-card__job-type-icon' }, [typeIcon(job.type)]),
      el('span', { class: 'chain-card__job-name' }, [job.name]),
      el('span', { class: 'chain-card__job-ts' }, [formatDate(job.timestamp)]),
      ...btns,
    ]);
    listEl.appendChild(row);
  }

  panel.appendChild(listEl);

  summaryRow.addEventListener('click', () => {
    expanded = !expanded;
    toggleIcon.textContent = expanded ? '▾' : '▸';
    listEl.classList.toggle('chain-card__jobs-list--hidden', !expanded);
    summaryRow.classList.toggle('chain-card__jobs-summary--expanded', expanded);
  });

  return panel;
}

// ---------------------------------------------------------------------------
// Log Preview (Requirements 13.1–13.5)
// ---------------------------------------------------------------------------

/** Tracks which job's log is currently expanded inline. */
let expandedLogId: string | null = null;

/**
 * attachLogPreview — attaches an inline log-preview toggle to a row element.
 *
 * Requirements 13.1: Show expand toggle only when hasLog === true (caller's responsibility).
 * Requirements 13.2: On expand, show loading indicator, fetch GET /view/:id (last 20 lines),
 *                    replace indicator with <pre> block inline.
 * Requirements 13.3: On non-2xx, show inline error message.
 * Requirements 13.4: Re-activating toggle on expanded row collapses and removes <pre> block.
 * Requirements 13.5: Only one log preview open at a time; opening another collapses the first.
 *
 * @param row   - The HTMLElement row to which the toggle button is appended.
 * @param jobId - The Job id used for the fetch URL and to track expanded state.
 */
export function attachLogPreview(row: HTMLElement, jobId: string): void {
  const btn = el('button', { class: 'log-preview-toggle', type: 'button' }, ['[Log preview]']);

  btn.addEventListener('click', () => {
    if (expandedLogId === jobId) {
      // Already expanded — collapse (Requirement 13.4)
      const existing = row.querySelector('.log-preview-content');
      if (existing) existing.remove();
      expandedLogId = null;
      btn.textContent = '[Log preview]';
      return;
    }

    // Collapse any other open preview (Requirement 13.5)
    if (expandedLogId !== null) {
      const otherContent = document.querySelector('.log-preview-content');
      if (otherContent) otherContent.remove();
    }

    // Expand this log (Requirement 13.2)
    expandedLogId = jobId;
    btn.textContent = '[Collapse]';

    const loading = el('span', { class: 'log-preview-content log-preview--loading' }, ['Loading\u2026']);
    row.appendChild(loading);

    fetch(`/view/${encodeURIComponent(jobId)}`)
      .then((res) => {
        loading.remove();
        if (!res.ok) {
          // Non-2xx (Requirement 13.3)
          row.appendChild(
            el('span', { class: 'log-preview-content log-preview--error' }, ['Failed to load log']),
          );
          return;
        }
        return res.text().then((text) => {
          const pre = el('pre', { class: 'log-preview-content log-preview--pre' }, [text]);
          row.appendChild(pre);
        });
      })
      .catch(() => {
        // Network error (Requirement 13.3)
        loading.remove();
        row.appendChild(
          el('span', { class: 'log-preview-content log-preview--error' }, ['Failed to load log']),
        );
      });
  });

  row.appendChild(btn);
}

// ---------------------------------------------------------------------------
// renderChainCard (Requirements 7.4, 7.5, 7.9)
// ---------------------------------------------------------------------------

/**
 * renderChainCard — renders the full ChainCard article element.
 *
 * @param chain - the Chain to render
 * @param linkedJobs - individual Job records linked to this chain
 */
export function renderChainCard(chain: Chain, linkedJobs: Job[]): HTMLElement {
  const chainId       = chain.chainId;
  // Derive overall status from individual jobs
  const overallStatus = linkedJobs.length > 0
    ? (['error','running','warning','complete','pending'] as const).reduce((best, s) =>
        linkedJobs.some(j => j.status === s) ? s : best, 'pending' as string)
    : 'pending';
  const delta         = chain.unsummarisedDelta ?? 0;

  // ── Header ────────────────────────────────────────────────────────────────
  const nameEl   = el('h3', { class: 'chain-card__name' }, [chain.displayName]);
  const badgeEl  = el('span', {
    class: `status-badge status-badge--${overallStatus}`,
  }, [overallStatus]);
  const header   = el('div', { class: 'chain-card__header' }, [nameEl, badgeEl]);

  // ── Meta row ──────────────────────────────────────────────────────────────
  const sessCount  = chain.sessions?.length ?? 0;
  const msgCount   = chain.totalMessages ?? 0;
  const wfCount    = chain.workflowCount ?? 0;
  const metaEl     = el('div', { class: 'chain-card__meta' }, [
    el('span', { class: 'chain-card__meta-item' }, [formatDate(chain.createdAt)]),
    el('span', { class: 'chain-card__meta-item' }, [`${sessCount} session${sessCount !== 1 ? 's' : ''}`]),
    el('span', { class: 'chain-card__meta-item' }, [`${msgCount} message${msgCount !== 1 ? 's' : ''}`]),
    el('span', { class: 'chain-card__meta-item' }, [`${wfCount} workflow${wfCount !== 1 ? 's' : ''}`]),
  ]);

  // ── ContextRing ───────────────────────────────────────────────────────────
  const ringEl = renderContextRing(chain.latestSession);

  // ── Last user message (3-line max, 200 char clamp) ───────────────────────
  const lastUserText = clampText(chain.latestSession?.lastUserMessage ?? '', 200);
  const lastUserEl   = el('p', {
    class: 'chain-card__last-user',
    style: '--line-clamp: 3',
  }, [lastUserText]);

  // ── Last agent response (2-line max, 160 char clamp, dimmed) ─────────────
  const lastAgentText = clampText(chain.latestSession?.lastAgentMessage ?? '', 160);
  const lastAgentEl   = el('p', {
    class: 'chain-card__last-agent chain-card__last-agent--dim',
    style: '--line-clamp: 2',
  }, [lastAgentText]);

  // ── JOBS summary panel ────────────────────────────────────────────────────
  const jobsEl = renderJobsSummaryPanel(linkedJobs);

  // ── Action buttons ────────────────────────────────────────────────────────
  const timelineBtn = el('button', { class: 'chain-card__btn' }, ['Timeline']);
  timelineBtn.addEventListener('click', () => {
    setState({ drawerChainId: chainId });
  });

  const resumeBtn = el('button', { class: 'chain-card__btn' }, ['Resume']);
  resumeBtn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('chain:resume', { detail: { chainId } }));
  });

  const viewBtn = el('button', { class: 'chain-card__btn' }, ['View chain']);
  viewBtn.addEventListener('click', () => {
    setState({ drawerChainId: chainId });
  });

  const actionChildren: (HTMLElement | string)[] = [timelineBtn];

  if (delta > 0) {
    const summariseBtn = el('button', { class: 'chain-card__btn chain-card__btn--summarise' }, [
      `Summarise ${delta}`,
    ]);
    summariseBtn.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('chain:summarise', { detail: { chainId } }));
    });
    actionChildren.push(summariseBtn);
  }

  actionChildren.push(resumeBtn, viewBtn);

  const actionsEl = el('div', { class: 'chain-card__actions' }, actionChildren);

  // ── Assemble card ─────────────────────────────────────────────────────────
  const leftCol = el('div', { class: 'chain-card__left' }, [
    header,
    metaEl,
    ringEl as unknown as HTMLElement,
    lastUserEl,
    lastAgentEl,
    actionsEl,
  ]);

  const children: HTMLElement[] = [leftCol];

  if (linkedJobs.length > 0) {
    const rightCol = el('div', { class: 'chain-card__right' }, [jobsEl]);
    children.push(rightCol);
  }

  const card = el('article', {
    class: `chain-card chain-card--${overallStatus}${linkedJobs.length > 0 ? ' chain-card--has-jobs' : ''}`,
  }, children);

  return card;
}
