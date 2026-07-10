// ---------------------------------------------------------------------------
// Workspace Filtering Helper Module
//
// Provides common utilities for filtering API responses by workspace ID.
// Implements validation, 404 responses for invalid workspace IDs, and
// case-sensitive exact string matching per Requirements 5.4, 5.9, 5.14, 5.19.
// ---------------------------------------------------------------------------

import type { WorkspaceConfig } from '../../config/workspace-config.ts';

/**
 * Interface for entities that have workspace identification
 */
export interface WorkspaceIdentified {
  workspaceId: string;
  [key: string]: any;
}

/**
 * Result of workspace validation and filtering
 */
export interface FilterResult<T extends WorkspaceIdentified> {
  /** HTTP status code (200 for success, 404 for invalid workspace) */
  status: number;
  /** Filtered data (empty array if workspace has no data, or all data if no filter) */
  data?: T[];
  /** Error message (only present when status is 404) */
  error?: string;
}

/**
 * Validate that a workspace ID exists in the loaded configuration
 * 
 * @param workspaceId - The workspace identifier to validate
 * @param workspaces - Array of loaded workspace configurations
 * @returns true if workspace exists, false otherwise
 * 
 * **Validates: Requirements 5.4, 5.9, 5.14, 5.19**
 */
export function validateWorkspaceId(
  workspaceId: string,
  workspaces: WorkspaceConfig[]
): boolean {
  return workspaces.some(w => w.id === workspaceId);
}

/**
 * Filter data by workspace ID with validation and appropriate HTTP responses
 * 
 * This function implements the common filtering pattern used across all API routes:
 * - Returns 404 with error message for invalid workspace IDs
 * - Returns 200 with empty array for valid workspaces with no data
 * - Returns 200 with filtered data for valid workspaces with matching data
 * - Returns 200 with all data when no filter is provided
 * 
 * @param data - Array of workspace-identified entities to filter
 * @param workspaceId - Optional workspace ID filter (null/undefined = no filter)
 * @param workspaces - Array of loaded workspace configurations for validation
 * @returns FilterResult with status, data, and optional error message
 * 
 * **Validates: Requirements 5.4, 5.9, 5.14, 5.19** (404 for invalid workspace)
 * **Validates: Requirements 5.4.1, 5.9.1, 5.14.1, 5.19.1** (200 with empty array for valid workspace with no data)
 * **Validates: Requirements 5.2, 5.7, 5.12, 5.17** (case-sensitive exact string matching)
 */
export function filterByWorkspace<T extends WorkspaceIdentified>(
  data: T[],
  workspaceId: string | null | undefined,
  workspaces: WorkspaceConfig[]
): FilterResult<T> {
  // No filter provided: return all data
  if (!workspaceId) {
    return {
      status: 200,
      data,
    };
  }

  // Validate workspace ID exists in configuration
  const isValidWorkspace = validateWorkspaceId(workspaceId, workspaces);
  
  if (!isValidWorkspace) {
    // Invalid workspace: return 404 with error message
    return {
      status: 404,
      error: `Workspace '${workspaceId}' does not exist`,
    };
  }

  // Valid workspace: filter data by case-sensitive exact match
  const filtered = data.filter(item => item.workspaceId === workspaceId);
  
  return {
    status: 200,
    data: filtered,
  };
}

/**
 * Create a JSON Response from a FilterResult
 * 
 * Helper function to convert FilterResult into a properly formatted HTTP Response
 * with appropriate status code and content-type headers.
 * 
 * @param result - FilterResult from filterByWorkspace
 * @returns Response object with JSON body
 */
export function createFilterResponse<T extends WorkspaceIdentified>(
  result: FilterResult<T>
): Response {
  if (result.status === 404) {
    return new Response(
      JSON.stringify({ error: result.error }),
      {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }
    );
  }

  return new Response(
    JSON.stringify(result.data),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'connection': 'close',
      },
    }
  );
}
