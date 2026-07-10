# Implementation Plan: Multi-Workspace Monitoring

## Overview

This implementation transforms AgentHQ from monitoring a single workspace to simultaneously monitoring multiple Kiro agent engagements through a unified dashboard. The approach follows six phases: configuration foundation, scanning architecture, API modifications, dashboard UI updates, queue/SSE integration, and comprehensive testing.

## Tasks

- [x] 1. Create workspace configuration module
  - [x] 1.1 Define WorkspaceConfig interface and configuration loader module
    - Create `src/config/workspace-config.ts` with `WorkspaceConfig` interface
    - Implement `ConfigurationLoader` interface with `loadWorkspaces()`, `validateWorkspace()`, and `applyDefaults()` methods
    - _Requirements: 1.1, 1.2, 1.3, 1.4_
  
  - [x] 1.2 Implement JSON schema validation and validation rules
    - Use Zod or similar library to validate workspace configuration JSON schema
    - Implement workspace ID regex validation: `^[a-z0-9-]{1,50}$`
    - Implement uniqueness check with case-sensitive comparison
    - Implement 50-workspace maximum limit
    - Implement required field validation (OUTPUT_DIR, SESSIONS_DIR, WORKSPACE_ROOT)
    - _Requirements: 1.2, 1.3, 1.10, 1.14_
  
  - [x] 1.3 Implement default application for optional fields
    - Apply CHAINS_DIR default to SESSIONS_DIR when omitted
    - Apply PROMPT_OUTPUT_DIR default to OUTPUT_DIR when omitted
    - Handle optional SPECS_DIR and queue file paths
    - _Requirements: 1.5, 1.6, 1.7_
  
  - [x] 1.4 Implement configuration error handling and logging
    - Log descriptive error for missing `workspaces.json` file and exit with non-zero code
    - Log descriptive error for malformed JSON with parse error details and exit
    - Log descriptive error for duplicate workspace IDs and exit
    - Log descriptive error for >50 workspaces and exit
    - Log descriptive warning for non-existent required paths, skip workspace, continue with others
    - Ensure zero valid workspaces after validation causes error and exit
    - _Requirements: 1.8, 1.9, 1.11, 1.12, 1.13, 1.15, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_
  
  - [x] 1.5 Write property tests for configuration validation (Properties 1-6)
    - **Property 1: Configuration JSON Round-Trip Preservation**
    - **Property 2: Workspace ID Validation Correctness**
    - **Property 3: Required Field Enforcement**
    - **Property 4: Optional Field Acceptance**
    - **Property 5: Workspace ID Uniqueness Enforcement**
    - **Property 6: Workspace Count Limit Enforcement**
    - Create `test/properties/config-validation.prop.test.ts`
    - Use fast-check with minimum 100 iterations per property
    - _Validates: Requirements 1.1-1.15_
  
  - [x] 1.6 Write unit tests for configuration error scenarios
    - Test missing `workspaces.json` file
    - Test malformed JSON
    - Test duplicate workspace IDs
    - Test zero valid workspaces
    - Create `test/unit/config-loader.test.ts`
    - _Requirements: 1.8, 1.9, 1.11, 1.15_

- [x] 2. Extend data models with workspace identification
  - [x] 2.1 Add workspaceId field to all domain interfaces
    - Update `Job`, `SessionState`, `Chain`, `JobChain`, `GitStatus`, `BackgroundJobRecord`, `BuildQueueRecord` interfaces in `src/types.ts`
    - Add `workspaceId: string` field to each interface
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 3.8_

- [x] 3. Checkpoint - Ensure configuration and data model changes compile
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement multi-workspace scanning architecture
  - [x] 4.1 Create per-workspace cache manager
    - Create `src/scan/workspace-cache.ts` with `PerWorkspaceCache<T>` interface
    - Implement Map-based cache storage keyed by workspace ID
    - Implement `get()`, `set()`, `invalidate()`, and `invalidateAll()` methods
    - Implement cache entry structure with data and timestamp
    - Apply 5-second TTL (existing `SCAN_CACHE_TTL` constant) per workspace
    - Create `CacheManager` interface with caches for sessions, chains, jobs, specs
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.6_
  
  - [x] 4.2 Refactor existing scanner functions to accept workspace context
    - Update `scanSessions()` in `src/scan/sessions.ts` to accept workspace config and populate `workspaceId`
    - Update `scanChains()` in `src/scan/chains.ts` to accept workspace config and populate `workspaceId`
    - Update `scanJobs()` in `src/scan/jobs.ts` to accept workspace config and populate `workspaceId`
    - Update `scanSpecs()` to accept workspace config and populate `workspaceId` (if spec scanning exists)
    - Fail entire workspace scan if workspace ID cannot be determined
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.6_
  
  - [x] 4.3 Implement git status scanner for multiple workspaces
    - Create or update git scanner to accept workspace config
    - Execute git commands in workspace's WORKSPACE_ROOT directory
    - Populate `workspaceId` field in GitStatus objects
    - Return GitStatus with clean: true and empty arrays for non-git workspaces
    - _Requirements: 2.5, 7.1, 7.2, 7.6_
  
  - [x] 4.4 Implement MultiWorkspaceScanner orchestrator
    - Create `src/scan/multi-workspace.ts` with `MultiWorkspaceScanner` interface
    - Implement `scanAll()` method that iterates over all workspace configurations
    - Implement `scanWorkspace()` method for single workspace scanning
    - Use `Promise.all()` for parallel workspace scanning
    - Catch errors per workspace, log warnings, continue to next workspace
    - Aggregate all results into unified collections
    - Integrate with per-workspace cache manager
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_
  
  - [x] 4.5 Write property tests for scanning and caching (Properties 7-14)
    - **Property 7: Scanner Invocation Completeness**
    - **Property 8: Data Aggregation Preservation**
    - **Property 9: Scan Error Isolation**
    - **Property 10: Workspace ID Population Consistency**
    - **Property 11: Cache Isolation Between Workspaces**
    - **Property 12: Surgical Cache Invalidation**
    - **Property 13: Per-Workspace TTL Independence**
    - **Property 14: Cache Invalidation of Non-Existent Workspace**
    - Create `test/properties/scanning.prop.test.ts` and `test/properties/caching.prop.test.ts`
    - Use fast-check with minimum 100 iterations per property
    - _Validates: Requirements 2.1-2.9, 4.1-4.9_
  
  - [x] 4.6 Write integration tests for filesystem path handling
    - Test scanner reads from workspace-specific paths
    - Test with non-existent paths and mixed valid/invalid workspaces
    - Create `test/integration/filesystem.integration.test.ts`
    - _Requirements: 1.12, 1.13, 2.7, 2.8_

- [x] 5. Checkpoint - Verify scanning and caching work correctly
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Add workspace filtering to API routes
  - [x] 6.1 Create common filtering helper function
    - Create `src/routes/helpers/filter.ts` with workspace filtering utility
    - Implement validation: check if workspace ID exists in configuration
    - Implement 404 response for invalid workspace IDs
    - Implement 200 with empty array for valid workspace IDs with no data
    - Implement case-sensitive exact string matching
    - _Requirements: 5.4, 5.9, 5.14, 5.19_
  
  - [x] 6.2 Update /api/chains route with workspace filtering
    - Accept optional `workspaceId` query parameter in `src/routes/chains.ts`
    - Apply filtering using common helper function
    - Return all chains when filter omitted
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.4.1, 5.5_
  
  - [x] 6.3 Update /api/jobs route with workspace filtering
    - Accept optional `workspaceId` query parameter in `src/routes/jobs.ts`
    - Apply filtering using common helper function
    - Return all jobs when filter omitted
    - _Requirements: 5.6, 5.7, 5.8, 5.9, 5.9.1, 5.10_
  
  - [x] 6.4 Update /api/sessions route with workspace filtering
    - Accept optional `workspaceId` query parameter (check existing routes for sessions endpoint)
    - Apply filtering using common helper function
    - Return all sessions when filter omitted
    - _Requirements: 5.11, 5.12, 5.13, 5.14, 5.14.1, 5.15_
  
  - [x] 6.5 Update /api/git route with workspace filtering
    - Accept optional `workspaceId` query parameter in `src/routes/git.ts`
    - Apply filtering using common helper function
    - Return git status array when multiple workspaces configured
    - Return null or error when zero workspaces configured
    - _Requirements: 5.16, 5.17, 5.18, 5.19, 5.19.1, 5.20, 7.3, 7.3.1_
  
  - [x] 6.6 Update /api/queue/status route with workspace filtering
    - Accept optional `workspaceId` query parameter (locate queue status route)
    - Apply filtering using common helper function
    - Return all queue status when filter omitted
    - _Requirements: 8.6, 8.7_
  
  - [x] 6.7 Write property tests for API filtering (Properties 15-17)
    - **Property 15: API Filtering Correctness**
    - **Property 16: API Invalid Workspace Response**
    - **Property 17: API Empty Result for Valid Workspace**
    - Create `test/properties/api-filtering.prop.test.ts`
    - Use fast-check with minimum 100 iterations per property
    - _Validates: Requirements 5.1-5.20, 8.6-8.7_
  
  - [x] 6.8 Write integration tests for API endpoints
    - Test end-to-end API requests with workspace filtering
    - Test CORS, headers, response formats
    - Test query parameter parsing
    - Create `test/integration/api.integration.test.ts`
    - _Requirements: 5.1-5.20_

- [x] 7. Checkpoint - Verify API filtering works correctly
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement dashboard workspace selector and filtering
  - [x] 8.1 Create workspace filter component
    - Create `src/dashboard/components/workspaceFilter.ts`
    - Implement `WorkspaceFilterComponent` interface with render(), onSelectionChange(), persistSelection(), restoreSelection() methods
    - Render dropdown with "All Workspaces" as first option
    - Render per-workspace options with display names (convert kebab-case to Title Case)
    - _Requirements: 6.1, 6.2, 6.3_
  
  - [x] 8.2 Implement workspace selection state management and persistence
    - Update `src/dashboard/state.ts` with workspace filter state
    - Implement localStorage persistence with key "selectedWorkspaceId"
    - Handle localStorage.setItem failures: log warning and continue
    - Restore selection on page load
    - Default to "All Workspaces" if restored ID doesn't match configured workspaces
    - _Requirements: 6.8, 6.9, 6.10, 6.11_
  
  - [x] 8.3 Update Dashboard view with workspace comparison table
    - Update `src/dashboard/pages/dashboard.ts`
    - Display workspace comparison table when "All Workspaces" selected
    - Show per-workspace metrics: total messages, context usage %, active sessions, pending queue items
    - Sort workspaces by activity level descending (primary: total messages, secondary: alphabetical)
    - Highlight workspaces with attention items (unsummarised sessions, queue errors)
    - Display git status blocks for all workspaces with workspace labels when "All" selected
    - Display git status for selected workspace only when specific workspace filtered
    - Fallback to all workspaces if selection state inconsistent
    - _Requirements: 6.7, 7.4, 7.4.1, 7.5, 7.7, 10.1, 10.2, 10.3, 10.4, 10.5, 10.5.1, 10.6, 10.6.1, 10.7_
  
  - [x] 8.4 Update Activity view to filter by selected workspace
    - Update `src/dashboard/pages/activity.ts`
    - Apply workspace filter to sessions display
    - Filter data based on selected workspace or show all when "All Workspaces" selected
    - _Requirements: 6.6_
  
  - [x] 8.5 Update Work view to filter by selected workspace
    - Update `src/dashboard/pages/work.ts`
    - Apply workspace filter to jobs display
    - Filter data based on selected workspace or show all when "All Workspaces" selected
    - _Requirements: 6.5_
  
  - [x] 8.6 Write property tests for dashboard filtering and metrics (Properties 18-20, 24-26)
    - **Property 18: Dashboard Filtering Logic Consistency**
    - **Property 19: Workspace Selection Persistence Round-Trip**
    - **Property 20: Workspace Selection Fallback Behavior**
    - **Property 24: Workspace Metrics Calculation Correctness**
    - **Property 25: Workspace Comparison Sort Correctness**
    - **Property 26: Attention Item Detection**
    - Create `test/properties/dashboard.prop.test.ts` and `test/properties/metrics.prop.test.ts`
    - Use fast-check with minimum 100 iterations per property
    - _Validates: Requirements 6.4-6.11, 10.1-10.7_
  
  - [x] 8.7 Write integration tests for dashboard interactions
    - Test browser-based interactions with real localStorage
    - Test workspace filter updates all views
    - Create `test/integration/dashboard.integration.test.ts`
    - _Requirements: 6.1-6.11_

- [x] 9. Checkpoint - Verify dashboard UI works correctly
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Implement multi-workspace queue management
  - [x] 10.1 Update queue poller to load queue files from all workspaces
    - Update `src/workers/queuePoller.ts`
    - Create `QueuePollerWorkspaceContext` interface
    - Load crawl, clone, and build queue files from each workspace's configured paths
    - Resolve relative queue file paths against WORKSPACE_ROOT
    - Parse queue entries and populate `workspaceId` field
    - Aggregate entries from all workspaces
    - _Requirements: 8.1, 8.2, 8.3, 8.4_
  
  - [x] 10.2 Implement workspace context resolution for queue entry dispatch
    - When dispatching queue entries, resolve paths in owning workspace context
    - Populate `workspaceId` field for all dispatched entries
    - Execute queue operations in workspace-specific directories
    - Display workspace identifier for each queue entry in dashboard
    - _Requirements: 8.5, 8.8_
  
  - [x] 10.3 Write property tests for queue management (Property 21)
    - **Property 21: Queue Entry Workspace Identification**
    - Create `test/properties/queue.prop.test.ts`
    - Use fast-check with minimum 100 iterations
    - _Validates: Requirements 8.5_
  
  - [x] 10.4 Write unit tests for queue poller modifications
    - Test queue file loading from workspace-specific paths
    - Test workspace context resolution
    - Create `test/unit/queue-poller.test.ts`
    - _Requirements: 8.1-8.5_

- [x] 11. Implement multi-workspace SSE updates
  - [x] 11.1 Update SSE broadcaster to include workspace identification
    - Update `src/workers/ssebroadcaster.ts`
    - Create `SSEUpdateEvent` interface with type and workspaceId fields
    - Include `workspaceId` field in all emitted events (chain, job, session, git updates)
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_
  
  - [x] 11.2 Implement client-side SSE filtering based on workspace selection
    - Update SSE client in `src/dashboard/main.ts`
    - Apply updates only for selected workspace when specific workspace filtered
    - Apply updates without workspaceId when specific workspace selected
    - Apply all updates when "All Workspaces" selected (including events with missing workspaceId)
    - _Requirements: 11.6, 11.6.1, 11.7_
  
  - [x] 11.3 Write property tests for SSE updates (Properties 27-29)
    - **Property 27: SSE Event Workspace Identification**
    - **Property 28: SSE Client Filtering with Selected Workspace**
    - **Property 29: SSE Client Filtering with "All Workspaces"**
    - Create `test/properties/sse.prop.test.ts`
    - Use fast-check with minimum 100 iterations per property
    - _Validates: Requirements 11.1-11.7_

- [x] 12. Checkpoint - Verify queue management and SSE updates work correctly
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Integration testing and documentation
  - [x] 13.1 Create example workspace configuration file
    - Create `workspaces.json.example` in repository root
    - Include example with multiple workspaces showing all optional fields
    - Include comments explaining each field (in accompanying README or docs)
    - _Requirements: 1.1-1.15_
  
  - [x] 13.2 Write performance integration tests
    - Create `test/integration/performance.integration.test.ts`
    - Test with 10-50 workspaces with realistic data volumes
    - Measure total scan time, verify <5 seconds target
    - Measure cache hit rates and invalidation performance
    - _Requirements: 2.9_
  
  - [x] 13.3 Write integration tests for git operations
    - Create test git repositories with various states (clean, modified, staged, untracked)
    - Verify git status scanner interprets `git status --porcelain` output correctly
    - Verify workspace-specific git operations execute in correct WORKSPACE_ROOT
    - Create `test/integration/git.integration.test.ts`
    - _Requirements: 7.1, 7.2, 7.6_
  
  - [x] 13.4 Create user documentation for workspace configuration
    - Create `docs/multi-workspace-setup.md`
    - Document configuration file structure
    - Document validation rules and error messages
    - Document workspace filter usage in dashboard
    - Include migration guide for single-workspace users
    - _Requirements: 1.1-1.15, 6.1-6.11_
  
  - [x] 13.5 Update README with multi-workspace setup instructions
    - Update `README.md` with multi-workspace configuration section
    - Include quick start example
    - Link to detailed documentation
    - _Requirements: 1.1-1.15_

- [x] 14. Final checkpoint - Verify all features work end-to-end
  - Ensure all tests pass, ask the user if questions arise.
  - Verify all 29 correctness properties pass
  - Verify performance benchmarks meet <5 second target
  - Verify documentation is complete

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation throughout implementation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- Integration tests verify external dependencies and end-to-end flows
- The design uses TypeScript, so all implementation will be in TypeScript
- Existing codebase uses Bun runtime and Vitest for testing
- Property-based tests use fast-check library with minimum 100 iterations

## Task Dependency Graph

```json
{
  "waves": [
    {
      "id": 0,
      "tasks": ["1.1", "2.1"]
    },
    {
      "id": 1,
      "tasks": ["1.2", "1.3"]
    },
    {
      "id": 2,
      "tasks": ["1.4", "1.5", "1.6"]
    },
    {
      "id": 3,
      "tasks": ["4.1", "4.2", "4.3"]
    },
    {
      "id": 4,
      "tasks": ["4.4", "4.5", "4.6"]
    },
    {
      "id": 5,
      "tasks": ["6.1"]
    },
    {
      "id": 6,
      "tasks": ["6.2", "6.3", "6.4", "6.5", "6.6"]
    },
    {
      "id": 7,
      "tasks": ["6.7", "6.8"]
    },
    {
      "id": 8,
      "tasks": ["8.1", "8.2"]
    },
    {
      "id": 9,
      "tasks": ["8.3", "8.4", "8.5"]
    },
    {
      "id": 10,
      "tasks": ["8.6", "8.7"]
    },
    {
      "id": 11,
      "tasks": ["10.1"]
    },
    {
      "id": 12,
      "tasks": ["10.2", "10.3", "10.4"]
    },
    {
      "id": 13,
      "tasks": ["11.1"]
    },
    {
      "id": 14,
      "tasks": ["11.2", "11.3"]
    },
    {
      "id": 15,
      "tasks": ["13.1", "13.2", "13.3", "13.4", "13.5"]
    }
  ]
}
```
