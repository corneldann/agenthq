// palette.ts — command palette overlay, command registry, filter + keyboard navigation
// Feature: monitor-dashboard-redesign
// Implements Requirements 11.1–11.6

import { getState, setState } from './state.js';
import type { Page } from './types.js';

// ---------------------------------------------------------------------------
// Command registry types
// ---------------------------------------------------------------------------

interface PaletteCommand {
  id: string;
  label: string;
  group: 'Navigation' | 'Git' | 'System' | 'Chains' | 'Jobs';
  prerequisite(): string | null;
  execute(): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _paletteEl: HTMLElement | null = null;
let _highlightedIdx = 0;
let _filteredCommands: PaletteCommand[] = [];

// ---------------------------------------------------------------------------
// Public API (keep existing exports intact — used by main.ts)
// ---------------------------------------------------------------------------

/**
 * Returns true if the command palette overlay is currently mounted in the DOM.
 */
export function isPaletteOpen(): boolean {
  return _paletteEl !== null && document.body.contains(_paletteEl);
}

/**
 * togglePalette — opens the palette if closed; closes it if open.
 * Called by Cmd/Ctrl+K in main.ts and by Escape.
 *
 * Requirement 11.1: opens with filter cleared and focused; Ctrl+K on open closes.
 */
export function togglePalette(): void {
  if (isPaletteOpen()) {
    _closePalette();
  } else {
    _openPalette();
  }
}

// ---------------------------------------------------------------------------
// Command registry builder — called fresh on every open (Req 11.2)
// ---------------------------------------------------------------------------

function _buildCommands(): PaletteCommand[] {
  const state = getState();
  const cmds: PaletteCommand[] = [];

  // --- Navigation ---
  const navItems: Array<{ id: string; label: string; page: Page }> = [
    { id: 'nav-dashboard', label: 'Go to Dashboard (G+D)', page: 'dashboard' },
    { id: 'nav-work',      label: 'Go to Work (G+W)',      page: 'work' },
    { id: 'nav-activity',  label: 'Go to Activity (G+A)',  page: 'activity' },
  ];

  for (const { id, label, page } of navItems) {
    cmds.push({
      id,
      label,
      group: 'Navigation',
      prerequisite: () => null,
      execute: () => { setState({ currentPage: page }); },
    });
  }

  // --- Git ---
  cmds.push({
    id: 'git-commit',
    label: 'Commit & Push',
    group: 'Git',
    prerequisite: () => {
      const { gitStatus } = getState();
      if (!gitStatus) return 'Git status not available';
      if (gitStatus.clean) return 'Nothing to commit — working tree is clean';
      return null;
    },
    execute: async () => {
      try {
        await fetch('/git-commit', { method: 'POST' });
      } catch (err) {
        throw new Error(`Git commit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  // --- System ---
  cmds.push({
    id: 'system-stop',
    label: 'Stop Agent',
    group: 'System',
    prerequisite: () => null,
    execute: async () => {
      try {
        await fetch('/stop', { method: 'POST' });
      } catch (err) {
        throw new Error(`Stop agent failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  // --- Chains (Resume + Summarise per chain) ---
  for (const chain of state.chains) {
    const name = chain.displayName || chain.chainId;

    cmds.push({
      id: `chain-resume-${chain.chainId}`,
      label: `Resume: ${name}`,
      group: 'Chains',
      prerequisite: () => null,
      execute: async () => {
        const res = await fetch(`/resume/${chain.chainId}`, { method: 'POST' });
        if (!res.ok) throw new Error(`Resume failed (${res.status})`);
      },
    });

    // Summarise only when there is unsummarised content (Req 11.2)
    if ((chain.unsummarisedDelta ?? 0) > 0) {
      cmds.push({
        id: `chain-summarise-${chain.chainId}`,
        label: `Summarise: ${name}`,
        group: 'Chains',
        prerequisite: () => null,
        execute: async () => {
          const res = await fetch(`/summarise/${chain.chainId}`, { method: 'POST' });
          if (!res.ok) throw new Error(`Summarise failed (${res.status})`);
        },
      });
    }
  }

  // --- Jobs (View output for running jobs) ---
  for (const job of state.jobs.filter((j) => j.status === 'running')) {
    cmds.push({
      id: `job-view-${job.id}`,
      label: `View output: ${job.name}`,
      group: 'Jobs',
      prerequisite: () => null,
      execute: () => {
        window.open(`/view/${job.id}`, '_blank');
      },
    });
  }

  return cmds;
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

function _filterCommands(all: PaletteCommand[], query: string): PaletteCommand[] {
  if (!query.trim()) return all;
  const lower = query.toLowerCase();
  return all.filter((c) => c.label.toLowerCase().includes(lower));
}

// ---------------------------------------------------------------------------
// DOM rendering helpers
// ---------------------------------------------------------------------------

const GROUP_ORDER: PaletteCommand['group'][] = [
  'Navigation', 'Git', 'System', 'Chains', 'Jobs',
];

function _renderResults(
  container: HTMLElement,
  commands: PaletteCommand[],
  highlightedIdx: number,
): void {
  container.innerHTML = '';

  if (commands.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'No commands match';
    Object.assign(empty.style, {
      padding: '16px',
      color: 'var(--md-on-surf-var, #b0b0c0)',
      fontSize: '0.85rem',
      textAlign: 'center',
    });
    container.appendChild(empty);
    return;
  }

  // Group by section, preserving GROUP_ORDER
  const byGroup = new Map<string, PaletteCommand[]>();
  for (const cmd of commands) {
    const list = byGroup.get(cmd.group) ?? [];
    list.push(cmd);
    byGroup.set(cmd.group, list);
  }

  let rowIdx = 0;

  for (const group of GROUP_ORDER) {
    const groupCmds = byGroup.get(group);
    if (!groupCmds || groupCmds.length === 0) continue;

    // Group header
    const header = document.createElement('div');
    header.textContent = group.toUpperCase();
    Object.assign(header.style, {
      padding: '6px 14px 4px',
      fontSize: '0.7rem',
      fontWeight: '600',
      letterSpacing: '0.08em',
      color: 'var(--md-on-surf-var, #888)',
      textTransform: 'uppercase',
    });
    container.appendChild(header);

    for (const cmd of groupCmds) {
      const idx = rowIdx;
      const row = document.createElement('div');
      row.dataset['cmdId'] = cmd.id;
      row.dataset['cmdIdx'] = String(idx);

      const isHighlighted = idx === highlightedIdx;
      Object.assign(row.style, {
        padding: '9px 16px',
        cursor: 'pointer',
        fontSize: '0.875rem',
        borderRadius: '6px',
        margin: '1px 6px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        background: isHighlighted
          ? 'var(--md-primary-cont, rgba(99,120,255,0.18))'
          : 'transparent',
        color: isHighlighted
          ? 'var(--md-on-primary-cont, #c0c8ff)'
          : 'var(--md-on-surf, #e0e0e0)',
      });
      if (isHighlighted) row.classList.add('highlighted');

      const labelSpan = document.createElement('span');
      labelSpan.textContent = cmd.label;
      labelSpan.style.flex = '1';
      row.appendChild(labelSpan);

      // Hover sets highlight
      row.addEventListener('mouseenter', () => {
        _highlightedIdx = idx;
        _rerenderHighlight(container);
      });

      row.addEventListener('click', () => {
        _highlightedIdx = idx;
        void _executeHighlighted();
      });

      container.appendChild(row);
      rowIdx++;
    }
  }
}

/** Re-apply highlight styles without full re-render (cheaper on mouse-move). */
function _rerenderHighlight(container: HTMLElement): void {
  const rows = container.querySelectorAll<HTMLElement>('[data-cmd-idx]');
  rows.forEach((row) => {
    const idx = Number(row.dataset['cmdIdx']);
    const isHighlighted = idx === _highlightedIdx;
    row.classList.toggle('highlighted', isHighlighted);
    row.style.background = isHighlighted
      ? 'var(--md-primary-cont, rgba(99,120,255,0.18))'
      : 'transparent';
    row.style.color = isHighlighted
      ? 'var(--md-on-primary-cont, #c0c8ff)'
      : 'var(--md-on-surf, #e0e0e0)';
  });
}

/** Scroll the highlighted row into view. */
function _scrollHighlightIntoView(container: HTMLElement): void {
  const row = container.querySelector<HTMLElement>('.highlighted');
  if (row) row.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Command execution (Req 11.4)
// ---------------------------------------------------------------------------

async function _executeHighlighted(): Promise<void> {
  const cmd = _filteredCommands[_highlightedIdx];
  if (!cmd) return;

  const prereqError = cmd.prerequisite();
  if (prereqError !== null) {
    _closePalette();
    try {
      const { enqueueToast } = await import('./toast.js');
      enqueueToast({
        id: crypto.randomUUID(),
        type: 'error',
        message: prereqError,
        persistent: true,
      });
    } catch {
      console.error('[palette] prerequisite failed:', prereqError);
    }
    return;
  }

  _closePalette();

  try {
    await cmd.execute();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      const { enqueueToast } = await import('./toast.js');
      enqueueToast({
        id: crypto.randomUUID(),
        type: 'error',
        message: msg,
        persistent: true,
      });
    } catch {
      console.error('[palette] execution error:', msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Open / Close
// ---------------------------------------------------------------------------

function _openPalette(): void {
  if (isPaletteOpen()) return;

  // Build fresh command list from current state (Req 11.2)
  const allCommands = _buildCommands();
  _filteredCommands = allCommands;
  _highlightedIdx = 0;

  // Backdrop
  const backdrop = document.createElement('div');
  backdrop.id = 'command-palette';
  Object.assign(backdrop.style, {
    position: 'fixed',
    inset: '0',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingTop: '15vh',
    background: 'rgba(0,0,0,0.6)',
    zIndex: '10000',
  });

  // Panel
  const panel = document.createElement('div');
  Object.assign(panel.style, {
    background: 'var(--md-surf-lowest, #141420)',
    border: '1px solid var(--md-outline, #444)',
    borderRadius: '12px',
    width: '520px',
    maxWidth: '90vw',
    maxHeight: '60vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    color: 'var(--md-on-surf, #e0e0e0)',
    fontFamily: 'inherit',
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
  });

  // Filter input (Req 11.1: cleared and focused on open)
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Type a command or search…';
  input.value = '';
  Object.assign(input.style, {
    padding: '14px 16px',
    background: 'transparent',
    border: 'none',
    borderBottom: '1px solid var(--md-outline, #444)',
    color: 'var(--md-on-surf, #e0e0e0)',
    fontSize: '0.95rem',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  });
  panel.appendChild(input);

  // Scrollable results container
  const results = document.createElement('div');
  Object.assign(results.style, {
    overflowY: 'auto',
    flex: '1',
    padding: '8px 0',
  });
  panel.appendChild(results);

  // Initial render
  _renderResults(results, _filteredCommands, _highlightedIdx);

  // Input: filter + re-render (Req 11.3)
  input.addEventListener('input', () => {
    _filteredCommands = _filterCommands(allCommands, input.value);
    _highlightedIdx = 0;
    _renderResults(results, _filteredCommands, _highlightedIdx);
  });

  // Keyboard navigation (Req 11.5, 11.6)
  panel.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      _closePalette(); // Req 11.5
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (_filteredCommands.length === 0) return;
      _highlightedIdx = Math.min(_highlightedIdx + 1, _filteredCommands.length - 1);
      _rerenderHighlight(results);
      _scrollHighlightIntoView(results);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (_filteredCommands.length === 0) return;
      _highlightedIdx = Math.max(_highlightedIdx - 1, 0);
      _rerenderHighlight(results);
      _scrollHighlightIntoView(results);
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      void _executeHighlighted(); // Req 11.6
    }
  });

  backdrop.appendChild(panel);

  // Backdrop click outside panel → close
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) _closePalette();
  });

  document.body.appendChild(backdrop);
  _paletteEl = backdrop;

  // Focus filter input (Req 11.1)
  input.focus();
}

function _closePalette(): void {
  if (_paletteEl) {
    _paletteEl.remove();
    _paletteEl = null;
  }
  _filteredCommands = [];
  _highlightedIdx = 0;
}
