# Requirements Document

## Introduction

AgentHQ is currently a single-workspace monitoring tool that tracks Kiro agent sessions, jobs, git status, and background queues for one engagement at a time. This feature transforms AgentHQ into a multi-workspace monitoring hub that simultaneously monitors multiple engagements/workspaces in a unified dashboard, allowing users to see all active work across all engagements, filter between workspaces, compare activity and context usage across projects, and manage queued prompts for multiple engagements.

## Glossary

- **Workspace**: A single engagement/project directory containing Kiro agent sessions, chains, jobs, and configuration
- **Workspace_Configuration**: A JSON structure defining multiple workspaces with identifiers and paths
- **Workspace_Identifier**: A unique string key (e.g., "scottish-water", "project-alpha") identifying a workspace
- **Multi_Workspace_Scanner**: The scanning subsystem that aggregates chains, jobs, and sessions from multiple workspaces
- **Workspace_Filter**: A UI control allowing users to filter dashboard data by workspace
- **Aggregated_Data**: Domain models (Chain, Job, SessionState) enriched with workspace identification
- **Per_Workspace_Cache**: Independent cache storage for each workspace to optimize scanning

## Requirements

### Requirement 1: Workspace Configuration

**User Story:** As a developer, I want to define multiple workspaces in configuration, so that AgentHQ can monitor all my engagements simultaneously.

#### Acceptance Criteria

1. THE Workspace_Configuration SHALL support a JSON file format located at `workspaces.json` in the AgentHQ repository root defining an array of workspace objects, WHERE each workspace object is a JSON object with string-valued properties
2. THE Workspace_Configuration SHALL require a unique Workspace_Identifier for each workspace, WHERE the Workspace_Identifier matches the regex pattern `^[a-z0-9-]{1,50}$` (lowercase alphanumeric and hyphens only, 1-50 characters)
3. THE Workspace_Configuration SHALL require OUTPUT_DIR, SESSIONS_DIR, WORKSPACE_ROOT properties for each workspace, WHERE each property value is a non-empty absolute directory path string
4. THE Workspace_Configuration SHALL support optional CHAINS_DIR, SPECS_DIR, PROMPT_OUTPUT_DIR properties for each workspace, WHERE each property value (if provided) is a non-empty absolute directory path string
5. WHEN CHAINS_DIR is omitted for a workspace, THE Configuration_Loader SHALL default CHAINS_DIR to the value of SESSIONS_DIR for that workspace
6. WHEN PROMPT_OUTPUT_DIR is omitted for a workspace, THE Configuration_Loader SHALL default PROMPT_OUTPUT_DIR to the value of OUTPUT_DIR for that workspace
7. THE Workspace_Configuration SHALL support optional queue file path properties (CRAWL_JOBS_FILE, CLONE_JOBS_FILE, BUILD_QUEUE_FILE) for each workspace, WHERE each property value (if provided) is a non-empty relative path string interpreted relative to WORKSPACE_ROOT
8. WHEN the JSON configuration file `workspaces.json` does not exist at the repository root, THE Configuration_Loader SHALL log a descriptive error, prevent any further execution, and exit with non-zero exit code
9. WHEN the JSON configuration file `workspaces.json` exists but contains malformed JSON (invalid syntax), THE Configuration_Loader SHALL log a descriptive error including the JSON parse error and exit with non-zero exit code
10. THE Workspace_Configuration SHALL validate that all Workspace_Identifier values are unique within the configuration array by case-sensitive string comparison
11. WHEN duplicate Workspace_Identifier values are detected, THE Configuration_Loader SHALL log a descriptive error naming all duplicate identifiers and exit with non-zero exit code
12. THE Workspace_Configuration SHALL validate that all required directory paths (OUTPUT_DIR, SESSIONS_DIR, WORKSPACE_ROOT) exist on the filesystem before loading the workspace
13. WHEN a required directory path does not exist, THE Configuration_Loader SHALL log a descriptive warning including the Workspace_Identifier and the non-existent path, skip that workspace, and continue loading remaining workspaces (see Requirement 9.8 for behavior when all workspaces are skipped)
14. THE Workspace_Configuration SHALL enforce a maximum of 50 workspaces in the configuration array
15. WHEN the workspace array exceeds 50 entries, THE Configuration_Loader SHALL log a descriptive error and exit with non-zero exit code

### Requirement 2: Multi-Workspace Scanning

**User Story:** As a developer, I want AgentHQ to scan all configured workspaces, so that I can see aggregated data from all my engagements.

#### Acceptance Criteria

1. THE Multi_Workspace_Scanner SHALL invoke session scanning for each configured workspace
2. THE Multi_Workspace_Scanner SHALL invoke chain scanning for each configured workspace
3. THE Multi_Workspace_Scanner SHALL invoke job scanning for each configured workspace
4. THE Multi_Workspace_Scanner SHALL invoke spec scanning for each configured workspace
5. THE Multi_Workspace_Scanner SHALL invoke git status scanning for each configured workspace
6. THE Multi_Workspace_Scanner SHALL aggregate all scanned data into unified collections
7. WHEN a workspace path does not exist, THE Multi_Workspace_Scanner SHALL log a warning and continue scanning remaining workspaces
8. WHEN a workspace scan fails, THE Multi_Workspace_Scanner SHALL log the error and continue scanning remaining workspaces
9. THE Multi_Workspace_Scanner SHALL complete all workspace scans within reasonable time bounds (under 5 seconds for typical configurations)

### Requirement 3: Workspace-Identified Data Models

**User Story:** As a developer, I want all domain models to include workspace identification, so that I can distinguish which engagement each chain/job/session belongs to.

#### Acceptance Criteria

1. THE Chain interface SHALL include a workspaceId field of type string
2. THE Job interface SHALL include a workspaceId field of type string
3. THE SessionState interface SHALL include a workspaceId field of type string
4. THE JobChain interface SHALL include a workspaceId field of type string
5. THE GitStatus interface SHALL include a workspaceId field of type string
6. WHEN scanning a workspace, THE Multi_Workspace_Scanner SHALL populate the workspaceId field with the corresponding Workspace_Identifier, and WHEN the workspace identifier cannot be determined due to missing metadata or corruption, THE Multi_Workspace_Scanner SHALL fail the scan entirely for that workspace
7. THE BackgroundJobRecord interface SHALL include a workspaceId field of type string
8. THE BuildQueueRecord interface SHALL include a workspaceId field of type string

### Requirement 4: Per-Workspace Caching

**User Story:** As a developer, I want independent caching for each workspace, so that rescanning one workspace does not invalidate cached data from other workspaces.

#### Acceptance Criteria

1. THE Per_Workspace_Cache SHALL maintain separate session cache storage keyed by Workspace_Identifier
2. THE Per_Workspace_Cache SHALL maintain separate chain cache storage keyed by Workspace_Identifier
3. THE Per_Workspace_Cache SHALL maintain separate job cache storage keyed by Workspace_Identifier
4. THE Per_Workspace_Cache SHALL maintain separate spec cache storage keyed by Workspace_Identifier
5. WHEN a workspace is rescanned, THE Per_Workspace_Cache SHALL invalidate only the cache entries for that Workspace_Identifier, leaving all other workspace cache entries unchanged
6. THE Per_Workspace_Cache SHALL apply the SCAN_CACHE_TTL duration independently to each workspace's cached data
7. WHEN cache invalidation is requested for a specific workspace, THE Per_Workspace_Cache SHALL invalidate only that workspace's cache
8. WHEN a cache lookup is performed for a Workspace_Identifier with no cached data, THE Per_Workspace_Cache SHALL allow automatic rescanning as an option or configuration to improve user experience
9. IF cache invalidation is requested for a Workspace_Identifier that does not exist in the cache, THEN THE Per_Workspace_Cache SHALL complete without error and without modifying other workspace caches

### Requirement 5: API Workspace Filtering

**User Story:** As a dashboard user, I want API routes to support workspace filtering, so that I can retrieve data for specific engagements.

#### Acceptance Criteria

1. THE /api/chains route (path: /chains) SHALL accept an optional workspaceId query parameter
2. WHEN a workspaceId query parameter is provided, THE /chains route SHALL perform case-sensitive exact string matching against the workspaceId field of each chain
3. WHEN a workspaceId query parameter is provided and matches one or more chains, THE /chains route SHALL return only chains where the workspaceId field equals the provided parameter value
4. WHEN a workspaceId query parameter is provided and does not match any configured Workspace_Identifier, THE /chains route SHALL return HTTP status code 404 with an appropriate error message indicating the workspace does not exist
4.1. WHEN a workspaceId query parameter is provided, matches a configured Workspace_Identifier, but that workspace has no chains, THE /chains route SHALL return an empty array with HTTP status code 200
5. WHEN the workspaceId query parameter is omitted, THE /chains route SHALL return chains from all workspaces with HTTP status code 200
6. THE /api/jobs route (path: /jobs) SHALL accept an optional workspaceId query parameter
7. WHEN a workspaceId query parameter is provided, THE /jobs route SHALL perform case-sensitive exact string matching against the workspaceId field of each job
8. WHEN a workspaceId query parameter is provided and matches one or more jobs, THE /jobs route SHALL return only jobs where the workspaceId field equals the provided parameter value
9. WHEN a workspaceId query parameter is provided and does not match any configured Workspace_Identifier, THE /jobs route SHALL return HTTP status code 404 with an appropriate error message indicating the workspace does not exist
9.1. WHEN a workspaceId query parameter is provided, matches a configured Workspace_Identifier, but that workspace has no jobs, THE /jobs route SHALL return an empty array with HTTP status code 200
10. WHEN the workspaceId query parameter is omitted, THE /jobs route SHALL return jobs from all workspaces
11. THE /api/sessions route (path: /sessions) SHALL accept an optional workspaceId query parameter
12. WHEN a workspaceId query parameter is provided, THE /sessions route SHALL perform case-sensitive exact string matching against the workspaceId field of each session
13. WHEN a workspaceId query parameter is provided and matches one or more sessions, THE /sessions route SHALL return only sessions where the workspaceId field equals the provided parameter value
14. WHEN a workspaceId query parameter is provided and does not match any configured Workspace_Identifier, THE /sessions route SHALL return HTTP status code 404 with an appropriate error message indicating the workspace does not exist
14.1. WHEN a workspaceId query parameter is provided, matches a configured Workspace_Identifier, but that workspace has no sessions, THE /sessions route SHALL return an empty array with HTTP status code 200
15. WHEN the workspaceId query parameter is omitted, THE /sessions route SHALL return sessions from all workspaces
16. THE /api/git route (path: /git) SHALL accept an optional workspaceId query parameter
17. WHEN a workspaceId query parameter is provided, THE /git route SHALL perform case-sensitive exact string matching against the workspaceId field of the git status
18. WHEN a workspaceId query parameter is provided and matches git status, THE /git route SHALL return only git status where the workspaceId field equals the provided parameter value
19. WHEN a workspaceId query parameter is provided and does not match any configured Workspace_Identifier, THE /git route SHALL return HTTP status code 404 with an appropriate error message indicating the workspace does not exist
19.1. WHEN a workspaceId query parameter is provided, matches a configured Workspace_Identifier, but that workspace has no git status data, THE /git route SHALL return an empty array with HTTP status code 200
20. WHEN the workspaceId query parameter is omitted, THE /git route SHALL return git status from all workspaces

### Requirement 6: Dashboard Workspace Selector

**User Story:** As a dashboard user, I want a workspace selector in the UI, so that I can filter the view to specific engagements or see all workspaces at once.

#### Acceptance Criteria

1. THE Dashboard SHALL display a Workspace_Filter control in the navigation area
2. THE Workspace_Filter SHALL include an "All Workspaces" option as the default selection
3. THE Workspace_Filter SHALL include an option for each configured Workspace_Identifier
4. WHEN a workspace is selected, THE Dashboard SHALL filter all displayed chains to that workspace
5. WHEN a workspace is selected, THE Dashboard SHALL filter all displayed jobs to that workspace
6. WHEN a workspace is selected, THE Dashboard SHALL filter all displayed sessions to that workspace
7. WHEN "All Workspaces" is selected, THE Dashboard SHALL display data from all workspaces
8. WHEN storing the selected workspace filter, IF localStorage.setItem fails, THEN THE Dashboard SHALL log a warning to the console and continue operation without persisting the selection
9. THE Dashboard SHALL persist the selected workspace filter in browser local storage using the key "selectedWorkspaceId"
10. WHEN restoring the last selected workspace filter on page load, IF the stored Workspace_Identifier does not match any configured workspace, THEN THE Dashboard SHALL default to "All Workspaces" selection
11. THE Dashboard SHALL restore the last selected workspace filter from browser local storage on page load

### Requirement 7: Multi-Workspace Git Status

**User Story:** As a developer, I want to see git status for all configured workspaces, so that I can track uncommitted changes across all engagements.

#### Acceptance Criteria

1. THE Git_Status_Scanner SHALL scan git status for each configured workspace
2. THE Git_Status_Scanner SHALL execute git commands in each workspace's WORKSPACE_ROOT directory
3. THE /api/git route SHALL return an array of GitStatus objects when multiple workspaces are configured
3.1. WHEN zero workspaces are configured or no workspaces exist, THE /api/git route SHALL return null or an appropriate error response (not an empty array)
4. THE Dashboard git section SHALL display git status for all workspaces when "All Workspaces" is selected
4.1. WHEN the selected workspace state is inconsistent (multiple selection modes active), THE Dashboard git section SHALL display all workspaces as a fallback
5. THE Dashboard git section SHALL display git status for the selected workspace when a specific workspace is filtered
6. WHEN a workspace is not a git repository, THE Git_Status_Scanner SHALL return a GitStatus object with clean: true and empty arrays
7. THE Dashboard git section SHALL display the Workspace_Identifier alongside each git status block

### Requirement 8: Multi-Workspace Queue Management

**User Story:** As a developer, I want to manage background queues (crawl, clone, build) for each workspace independently, so that queue operations are scoped to the correct engagement.

#### Acceptance Criteria

1. THE Queue_Poller SHALL load queue files from each workspace's configured paths
2. THE Queue_Poller SHALL process crawl queue entries in the context of the owning workspace
3. THE Queue_Poller SHALL process clone queue entries in the context of the owning workspace
4. THE Queue_Poller SHALL process build queue entries in the context of the owning workspace
5. WHEN a queue entry is dispatched, THE Queue_Poller SHALL populate the workspaceId field with the corresponding Workspace_Identifier
6. THE /api/queue/status route SHALL return queue status for all workspaces
7. THE /api/queue/status route SHALL accept an optional workspaceId query parameter to filter by workspace
8. THE Dashboard queue section SHALL display the Workspace_Identifier for each queue entry

### Requirement 9: Configuration Validation and Error Handling

**User Story:** As a developer, I want clear error messages when workspace configuration is invalid, so that I can quickly diagnose and fix configuration issues.

#### Acceptance Criteria

1. WHEN a Workspace_Identifier is duplicated, THE Configuration_Loader SHALL log a descriptive error and exit
2. WHEN a required path (OUTPUT_DIR, SESSIONS_DIR, WORKSPACE_ROOT) is missing from the configuration schema, THE Configuration_Loader SHALL log a descriptive error and exit
3. WHEN a required path does not exist on the filesystem, THE Configuration_Loader SHALL log a descriptive warning and skip that workspace
3.1. WHEN a required path (OUTPUT_DIR, SESSIONS_DIR, WORKSPACE_ROOT) is missing during individual workspace loading (not initial validation), THE Configuration_Loader SHALL log a descriptive warning, skip that workspace, and continue processing other workspaces
3.2. WHEN schema validation passes but individual workspace configurations cause warnings (such as non-existent paths), THE Configuration_Loader SHALL continue processing other workspaces
4. WHEN the configuration file is not valid JSON, THE Configuration_Loader SHALL log a descriptive error and exit
5. WHEN no workspaces are successfully loaded due to configuration errors (missing file, malformed JSON, duplicate IDs, exceeding 50-workspace limit, schema validation failures), THE Configuration_Loader SHALL log a descriptive error and exit
6. THE Configuration_Loader SHALL validate the configuration file schema before loading workspaces
7. WHEN a workspace configuration is invalid, THE Configuration_Loader error message SHALL include the Workspace_Identifier and the specific validation failure
8. WHEN no workspaces are successfully loaded due to runtime conditions (empty workspaces array, all workspaces skipped due to non-existent filesystem paths), THE Configuration_Loader SHALL log a descriptive warning and return an empty array, allowing the application to continue execution

### Requirement 10: Dashboard Workspace Comparison

**User Story:** As a developer, I want to compare activity metrics across workspaces, so that I can identify which engagements are most active or need attention.

#### Acceptance Criteria

1. THE Dashboard SHALL display total message count per workspace in the activity summary
2. THE Dashboard SHALL display total context usage percentage per workspace in the activity summary
3. THE Dashboard SHALL display active session count per workspace in the activity summary
4. THE Dashboard SHALL display pending queue item count per workspace in the activity summary
5. WHEN "All Workspaces" is selected, THE Dashboard SHALL display a comparison table or chart of workspace metrics
5.1. THE Dashboard git section SHALL display git status for the selected workspace with workspace-specific formatting, layout, or additional details when a specific workspace is filtered
6. THE Dashboard workspace comparison SHALL sort workspaces by activity level (descending)
6.1. WHEN multiple workspaces have identical activity metrics (same message counts, context usage, active sessions, and pending queue items), THE Dashboard SHALL apply a secondary sort criteria (workspace name alphabetically or creation date) to determine the order
7. THE Dashboard workspace comparison SHALL highlight workspaces with pending attention items (unsummarised sessions, queue errors) regardless of activity level

### Requirement 11: Multi-Workspace SSE Updates

**User Story:** As a dashboard user, I want real-time updates for all workspaces, so that I see live changes across all engagements without manual refresh.

#### Acceptance Criteria

1. THE SSE_Broadcaster SHALL emit update events for all configured workspaces
2. THE SSE update payload SHALL include the Workspace_Identifier for each updated entity
3. WHEN a chain is updated, THE SSE_Broadcaster SHALL include the workspaceId in the chain update event
4. WHEN a job is updated, THE SSE_Broadcaster SHALL include the workspaceId in the job update event
5. WHEN a session is updated, THE SSE_Broadcaster SHALL include the workspaceId in the session update event
6. THE Dashboard SHALL apply SSE updates only to entities matching the currently selected Workspace_Filter
6.1. WHEN an SSE update arrives without a workspace identifier (workspaceId field missing or null) and a specific workspace is selected, THE Dashboard SHALL apply the update to the displayed data
7. WHEN "All Workspaces" is selected, THE Dashboard SHALL apply all SSE updates to the display regardless of workspaceId, including updates with missing or mismatched workspace identifiers
