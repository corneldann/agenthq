// components/workspaceFilter.ts — workspace selector dropdown in navigation area
// Feature: multi-workspace-monitoring
// Implements Requirements 6.1, 6.2, 6.3

import { el } from '../utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** localStorage key used to persist the selected workspace ID. */
const SELECTED_WORKSPACE_KEY = 'selectedWorkspaceId';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface WorkspaceFilterState {
  /** null means "All Workspaces" is selected */
  selectedWorkspaceId: string | null;
  availableWorkspaces: { id: string; displayName: string }[];
}

export interface WorkspaceFilterComponent {
  /**
   * Render workspace selector dropdown.
   * @param state Current filter state
   * @returns Root HTMLElement for the filter control
   */
  render(state: WorkspaceFilterState): HTMLElement;

  /**
   * Handle workspace selection change.
   * @param workspaceId Selected workspace ID or null for "All Workspaces"
   */
  onSelectionChange(workspaceId: string | null): void;

  /**
   * Persist selection to localStorage.
   * If localStorage.setItem() fails, logs a warning and continues.
   * @param workspaceId Workspace ID to persist, or null for "All Workspaces"
   */
  persistSelection(workspaceId: string | null): void;

  /**
   * Restore selection from localStorage.
   * @returns Persisted workspace ID or null if not set / parse fails
   */
  restoreSelection(): string | null;
}

// ---------------------------------------------------------------------------
// Utility: kebab-case → Title Case
// ---------------------------------------------------------------------------

/**
 * Converts a kebab-case workspace ID to a human-readable Title Case display name.
 *
 * Examples:
 *   "scottish-water"  → "Scottish Water"
 *   "project-alpha"   → "Project Alpha"
 *   "my-great-app"    → "My Great App"
 *   "singleword"      → "Singleword"
 *
 * @param id - Workspace identifier string (kebab-case)
 * @returns Display name in Title Case
 */
export function kebabToTitleCase(id: string): string {
  return id
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Selection change callback registry
// ---------------------------------------------------------------------------

/** Registered handlers called whenever the workspace selection changes. */
const _changeHandlers: Set<(workspaceId: string | null) => void> = new Set();

/**
 * Register a callback for workspace selection changes.
 * Returns an unsubscribe function.
 */
export function onWorkspaceChange(
  handler: (workspaceId: string | null) => void,
): () => void {
  _changeHandlers.add(handler);
  return () => {
    _changeHandlers.delete(handler);
  };
}

// ---------------------------------------------------------------------------
// WorkspaceFilterComponent implementation
// ---------------------------------------------------------------------------

/**
 * Creates and returns a WorkspaceFilterComponent instance.
 *
 * The component manages its own root element — subsequent calls to render()
 * update the existing element's contents rather than creating a new one,
 * ensuring the DOM node can be placed once in the navigation area and remain
 * stable across state refreshes.
 *
 * Requirement 6.1: displayed in navigation area, visible on all pages.
 * Requirement 6.2: "All Workspaces" option is the default / first option.
 * Requirement 6.3: per-workspace options with Title Case display names.
 */
export function createWorkspaceFilter(): WorkspaceFilterComponent {
  /** Persistent root wrapper element — created once, updated on re-render. */
  let _root: HTMLElement | null = null;
  /** Persistent <select> element — recreated on each render() call. */
  let _select: HTMLSelectElement | null = null;

  // -------------------------------------------------------------------------
  // persistSelection
  // -------------------------------------------------------------------------

  function persistSelection(workspaceId: string | null): void {
    try {
      if (workspaceId === null) {
        localStorage.removeItem(SELECTED_WORKSPACE_KEY);
      } else {
        localStorage.setItem(SELECTED_WORKSPACE_KEY, workspaceId);
      }
    } catch (err) {
      // Requirement 6.8: if localStorage.setItem() fails, log warning and continue.
      console.warn(
        '[workspaceFilter] Failed to persist workspace selection to localStorage:',
        err,
      );
    }
  }

  // -------------------------------------------------------------------------
  // restoreSelection
  // -------------------------------------------------------------------------

  function restoreSelection(): string | null {
    try {
      return localStorage.getItem(SELECTED_WORKSPACE_KEY);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // onSelectionChange
  // -------------------------------------------------------------------------

  function onSelectionChange(workspaceId: string | null): void {
    persistSelection(workspaceId);
    _changeHandlers.forEach((fn) => fn(workspaceId));
  }

  // -------------------------------------------------------------------------
  // render
  // -------------------------------------------------------------------------

  function render(state: WorkspaceFilterState): HTMLElement {
    // Create root wrapper once; reuse on subsequent renders.
    if (_root === null) {
      _root = el('div', { class: 'workspace-filter', 'data-component': 'workspace-filter' });
    }

    // Clear existing contents so we can rebuild the <select> element.
    _root.innerHTML = '';

    // Label — visually hidden but accessible.
    const label = el('label', {
      class: 'workspace-filter__label',
      for: 'workspace-select',
    }, ['Workspace']);
    label.style.cssText = [
      'position:absolute',
      'width:1px',
      'height:1px',
      'padding:0',
      'margin:-1px',
      'overflow:hidden',
      'clip:rect(0,0,0,0)',
      'white-space:nowrap',
      'border:0',
    ].join(';');

    // <select> element.
    const select = document.createElement('select');
    select.id = 'workspace-select';
    select.className = 'workspace-filter__select';
    _select = select;

    // Requirement 6.2: "All Workspaces" as first/default option.
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = 'All Workspaces';
    select.appendChild(allOption);

    // Requirement 6.3: one option per workspace with Title Case display name.
    for (const workspace of state.availableWorkspaces) {
      const option = document.createElement('option');
      option.value = workspace.id;
      option.textContent = workspace.displayName;
      select.appendChild(option);
    }

    // Set the current selection.
    select.value = state.selectedWorkspaceId ?? '';

    // Wire up change handler.
    select.addEventListener('change', () => {
      const value = select.value;
      const selectedId = value === '' ? null : value;
      onSelectionChange(selectedId);
    });

    _root.appendChild(label);
    _root.appendChild(select);

    return _root;
  }

  // -------------------------------------------------------------------------
  // Return component interface
  // -------------------------------------------------------------------------

  return {
    render,
    onSelectionChange,
    persistSelection,
    restoreSelection,
  };
}

// ---------------------------------------------------------------------------
// Convenience: derive WorkspaceFilterState from available workspace configs
// ---------------------------------------------------------------------------

/**
 * Build a WorkspaceFilterState from a list of workspace IDs.
 * Display names are derived from the IDs using kebabToTitleCase.
 *
 * @param workspaceIds  - Array of workspace ID strings
 * @param selectedId    - Currently selected workspace ID, or null for "All"
 * @returns Ready-to-use WorkspaceFilterState
 */
export function buildFilterState(
  workspaceIds: string[],
  selectedId: string | null,
): WorkspaceFilterState {
  return {
    selectedWorkspaceId: selectedId,
    availableWorkspaces: workspaceIds.map((id) => ({
      id,
      displayName: kebabToTitleCase(id),
    })),
  };
}
