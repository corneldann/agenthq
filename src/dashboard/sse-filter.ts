// sse-filter.ts — pure SSE client-side filtering logic
// Feature: multi-workspace-monitoring
// Implements Requirements 11.6, 11.6.1, 11.7

import type { SSEUpdateEvent } from './types';

/**
 * Determines whether an incoming SSE update should be applied to the current
 * dashboard view, based on the currently selected workspace filter.
 *
 * Rules (Requirements 11.6, 11.6.1, 11.7):
 *   - selectedWorkspaceId === null  → "All Workspaces": apply ALL updates
 *   - selectedWorkspaceId set AND event.workspaceId matches → apply update
 *   - selectedWorkspaceId set AND event.workspaceId missing/null/empty → apply update (Req 11.6.1)
 *   - selectedWorkspaceId set AND event.workspaceId is a different workspace → ignore
 *
 * This function is pure — it has no side effects and no browser dependencies,
 * making it straightforward to unit-test in a Node/Bun environment.
 *
 * @param event             The parsed SSEUpdateEvent from the server.
 * @param selectedWorkspace The currently selected workspace ID, or null for "All Workspaces".
 * @returns true if the update should be applied to the view.
 */
export function shouldApplySSEUpdate(
  event: SSEUpdateEvent,
  selectedWorkspace: string | null,
): boolean {
  // Requirement 11.7: "All Workspaces" selected — apply every update
  if (selectedWorkspace === null) {
    return true;
  }

  // Requirement 11.6: specific workspace selected — apply only matching updates
  if (event.workspaceId === selectedWorkspace) {
    return true;
  }

  // Requirement 11.6.1: update without workspace ID — apply to current view
  if (!event.workspaceId) {
    return true;
  }

  // Different workspace — ignore
  return false;
}
