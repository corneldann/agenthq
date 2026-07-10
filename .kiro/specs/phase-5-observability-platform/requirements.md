# Requirements Document

## Introduction

This document specifies requirements for transforming AgentHQ from a monitoring dashboard into a full observability platform. The enhancement adds three major capabilities: bidirectional WebSocket communication for interactive agent control, SQLite/PostgreSQL persistence for fast queries and historical tracking, and advanced analytics for performance metrics, cost analysis, and bottleneck detection.

The current system uses unidirectional Server-Sent Events (SSE), file-based storage with in-memory TTL caches (5-10s expiry), and basic status displays. These limitations prevent interactive control, efficient time-range queries, historical trend analysis, and performance optimization.

## Glossary

- **AgentHQ**: Developer agent monitoring dashboard built with Bun, TypeScript, and file-based storage
- **SSE**: Server-Sent Events — unidirectional server-to-client push protocol (HTTP-based)
- **WebSocket**: Bidirectional TCP communication protocol for real-time client-server messaging
- **Workspace**: Monitored Kiro agent execution environment with dedicated output/session directories
- **Job**: Agent execution instance with status, logs, and metrics (type: Job)
- **Chain**: Sequence of related sessions grouped by topic (type: Chain)
- **Session**: Kiro conversation state snapshot (type: SessionState)
- **Scanner**: File system reading functions in src/scan/ (jobs.ts, chains.ts, sessions.ts)
- **Cache_Manager**: Per-workspace TTL-based in-memory cache (src/scan/workspace-cache.ts)
- **DB_Layer**: Database abstraction interface supporting SQLite and PostgreSQL
- **SQLite**: Embedded SQL database (zero-config, single-file, ACID-compliant)
- **PostgreSQL**: Client-server SQL database (production-grade, multi-user)
- **WAL_Mode**: Write-Ahead Logging mode for SQLite (improves concurrency)
- **Analytics_Engine**: Performance, cost, and bottleneck analysis computation module
- **Subscription**: Client registration to receive updates for specific workspace/chain/job
- **Command**: Client-initiated action (cancel job, pause agent, commit git)
- **Acknowledgement**: Server confirmation of command receipt and processing status
- **ITPM**: Input Tokens Per Minute — API rate limit constraint
- **Bottleneck**: Operation taking significantly longer than average for its type (>2x)
- **Anomaly**: Statistical outlier in performance metrics (>3 standard deviations)
- **Round_Trip_Property**: Serialize-deserialize must preserve original value (parse ∘ format = identity)

## Requirements

### Requirement 1: WebSocket Server Infrastructure

**User Story:** As a dashboard user, I want bidirectional real-time communication with the server, so that I can send commands and receive updates without separate HTTP requests.

#### Acceptance Criteria

1. WHEN a client connects to the WebSocket endpoint at `/ws`, THE WebSocket_Server SHALL upgrade the HTTP connection to WebSocket protocol
2. IF the WebSocket upgrade fails, THEN THE WebSocket_Server SHALL respond with HTTP 400 and error details
3. WHEN a WebSocket connection is established, THE WebSocket_Server SHALL send a `connected` message containing available workspace IDs and a unique client ID
4. WHEN a client sends a `ping` message, THE WebSocket_Server SHALL respond with a `pong` message within 100 milliseconds
5. IF a WebSocket connection is idle for 30 seconds without ping/pong, THEN THE WebSocket_Server SHALL close the connection
6. WHEN a client disconnects, THE WebSocket_Server SHALL attempt to remove all subscriptions for that client ID; IF subscription removal fails, THE WebSocket_Server SHALL log the failure and complete the disconnect process
7. THE WebSocket_Server SHALL support at least 100 concurrent connections with ≤100ms latency per message; THE WebSocket_Server SHALL allow connections beyond 100 and latency beyond 100ms (treat limits as performance guidelines, not hard caps)
8. FOR ALL valid JSON messages M, parse(stringify(M)) SHALL equal M (round-trip property)


### Requirement 2: WebSocket Message Protocol

**User Story:** As a developer, I want a well-defined message protocol, so that client-server communication is predictable and type-safe.

#### Acceptance Criteria

1. THE WebSocket_Message_Parser SHALL reject messages larger than 1MB with error "message too large"
2. IF a client sends a message that fails JSON.parse, THEN THE WebSocket_Server SHALL close the connection immediately with code 1003
3. THE WebSocket_Message_Parser SHALL validate all incoming messages against the ClientMessage type schema
4. IF a client sends an invalid message structure, THEN THE WebSocket_Server SHALL send an error acknowledgement with validation details including field path and expected type
5. THE WebSocket_Server SHALL assign a unique command ID (format: `cmd_${timestamp}_${random}`) to each client command for acknowledgement tracking
6. WHEN a command is processed successfully, THE WebSocket_Server SHALL send an acknowledgement with `success: true` and the command ID; IF the acknowledgement fails to send due to network issues AND the command reached the processing stage, THE WebSocket_Server SHALL retry sending the acknowledgement; acknowledgements SHALL only be sent after command processing completes (successful delivery implies processing completed)
7. WHEN a command fails validation or execution, THE WebSocket_Server SHALL send an acknowledgement with `success: false`, the command ID, and error description

### Requirement 3: Subscription Management

**User Story:** As a dashboard user, I want to subscribe to specific workspaces and chains, so that I only receive relevant updates and reduce bandwidth.

#### Acceptance Criteria

1. WHEN a client sends a `subscribe` message with a workspace ID, THE Subscription_Manager SHALL send an acknowledgement with `success: true`
2. WHEN a client sends a `subscribe` message with a chain ID, THE Subscription_Manager SHALL send an acknowledgement and add that chain to the client's subscription set
3. IF a client subscribes to a workspace already in their subscription set AND the client has actively sent a subscribe request, THEN THE Subscription_Manager SHALL return `{success: true, status: "already_subscribed"}` without creating a duplicate
4. WHEN a client sends an `unsubscribe` message with a non-existent subscription ID, THE Subscription_Manager SHALL return `{success: true, status: "not_subscribed"}` (idempotent)
5. WHEN a client sends an `unsubscribe` message, THE Subscription_Manager SHALL remove the specified subscription from the client's set
6. WHEN a job update occurs, THE WebSocket_Broadcaster SHALL send the update only to clients subscribed to that job's specific chain; IF a client is subscribed to the job's workspace but NOT to the job's chain, the update SHALL NOT be sent
7. THE Subscription_Manager SHALL support at least 10 concurrent subscriptions per client with ≤100ms per subscription operation

### Requirement 4: Interactive Agent Control

**User Story:** As a dashboard user, I want to cancel, pause, and resume agents from the dashboard, so that I can manage agent execution without using the CLI.

#### Acceptance Criteria

1. WHEN a client sends a `cancel-job` command with a job ID that exists in the job registry, THE Job_Controller SHALL terminate the agent process within 5 seconds
2. WHEN a job is cancelled, THE Job_Controller SHALL update the job status to "error" with reason "cancelled by user"
3. WHEN a client sends a `pause-agent` command with a session hash in "running" state, THE Agent_Controller SHALL suspend agent execution within 2 seconds
4. WHEN a client sends a `resume-agent` command with a session hash in "paused" state, THE Agent_Controller SHALL resume agent execution within 2 seconds
5. IF a command targets a non-existent job or session, THEN THE Command_Handler SHALL return an acknowledgement `{success: false, error: "not found", commandId: "..."}`
6. IF a client sends `pause-agent` for a session NOT in "running" state, THEN THE Command_Handler SHALL return `{success: false, error: "invalid state transition: cannot pause from <current_state>"}`
7. THE Command_Handler SHALL validate that the workspace ID matches the job's or session's workspace for ALL commands processed by the Command_Handler, returning error "workspace mismatch" on failure; IF validation fails AND the command cannot execute, the system SHALL still return an error response containing the validation failure details
8. WHEN an agent control command is executed (regardless of whether the state change succeeded), THE WebSocket_Broadcaster SHALL notify all subscribed clients with `{type: "status-change", jobId, oldStatus, newStatus, timestamp, success: boolean}`

### Requirement 5: Multi-User Collaboration

**User Story:** As a team member, I want to see other users' actions in real-time, so that we can coordinate work and avoid conflicts.

#### Acceptance Criteria

1. WHEN a user executes a command, THE WebSocket_Broadcaster SHALL send a `user-action` message `{userId, action, target, timestamp}` to all clients subscribed to the affected workspace
2. WHEN a user commits via the git section, THE WebSocket_Broadcaster SHALL notify all workspace subscribers including the committer within 1 second
3. WHEN a command fails validation or execution, THE WebSocket_Broadcaster SHALL send an error notification `{type: "command-error", userId, commandId, error}` to the originating client only
4. THE WebSocket_Server SHALL support at least 10 concurrent users per workspace; THE WebSocket_Server SHALL guarantee no message loss regardless of the number of active users in the workspace (including 1-2 users)
5. WHEN multiple users send commands concurrently, THE Command_Handler SHALL process them sequentially in arrival order, with each command's acknowledgement sent before processing the next; WHEN there is only one active user, THE Command_Handler SHALL still enforce sequential processing; THE Command_Handler SHALL send acknowledgements regardless of whether commands are actually concurrent

### Requirement 6: Database Schema and Storage

**User Story:** As a system administrator, I want a persistent database layer, so that queries are fast and historical data is preserved.

#### Acceptance Criteria

1. THE DB_Layer SHALL support SQLite with zero configuration (no environment variables required beyond DB_PATH)
2. WHERE PostgreSQL is configured, THE DB_Layer SHALL support PostgreSQL as an alternative database engine; IF PostgreSQL drivers or libraries are unavailable at runtime, THE DB_Layer SHALL fail gracefully with a clear error message indicating the missing dependency
3. THE Database_Schema SHALL include tables for workspaces, jobs, chains, sessions, job_status_history, and job_metrics
4. WHEN the database is initialized, THE Migration_System SHALL first create all tables, THEN create all indexes (indexes SHALL NOT be created before the tables they reference exist), and all operations SHALL complete idempotently (safe to run multiple times)
5. THE Database_Schema SHALL define foreign key constraints between jobs/chains/sessions and their workspaces
6. WHEN database initialization completes, THE SQLite_Adapter SHALL enable WAL mode for improved concurrency
7. THE Schema_Version_Table SHALL track the current schema version for migration management
8. IF database connection fails, THEN THE DB_Layer SHALL log error "database connection failed: <reason>" and fall back to file scanning

### Requirement 7: File System Watchers

**User Story:** As a developer, I want the database to update automatically when files change, so that I don't need to manually trigger rescans.

#### Acceptance Criteria

1. WHEN a job markdown file is created or modified AND the file parses successfully, THE Job_Watcher SHALL upsert the job record within 1 second
2. IF a file fails to parse for any reason (missing fields, malformed JSON, structural issues), THEN THE File_Watcher SHALL log error "parse failed: <path>: <reason>", the database state SHALL remain unchanged, and no upsert operation SHALL be attempted; WHEN the parsing failure is unrecoverable and requires manual intervention, THE File_Watcher SHALL send admin notifications OR quarantine the file
3. IF a file is parsed successfully but database upsert fails, THEN THE File_Watcher SHALL immediately schedule a retry attempt, log error "upsert failed: <path>: <db_error>", and retry on next file change
4. WHEN a file is deleted, THE File_Watcher SHALL mark the corresponding database record as deleted (soft delete) within 1 second
5. THE File_Watcher SHALL debounce rapid file changes: IF multiple saves occur within 500ms, THEN only the last write SHALL trigger a database update
6. WHEN the monitor starts, THE File_Watcher SHALL perform an initial full scan within 30 seconds before starting incremental updates; IF the initial scan cannot complete within 30 seconds due to file count exceeding processing capacity OR timeout expiration, THE File_Watcher SHALL fail startup and require manual intervention to reduce the file count OR increase the timeout
7. IF two files with the same job ID but different content are detected, THEN THE File_Watcher SHALL use the file with the most recent modification time


### Requirement 8: Database Query Performance

**User Story:** As a dashboard user, I want queries to return results quickly, so that the dashboard feels responsive.

#### Acceptance Criteria

1. WHEN querying jobs filtered by workspace and status with an appropriate index, THE DB_Layer SHALL return results within 75 milliseconds for databases with up to 8,000 jobs
2. WHEN querying jobs sorted by timestamp descending, THE DB_Layer SHALL use the `idx_workspace_timestamp` index for efficient retrieval
3. WHEN querying chains by workspace ordered by last active time, THE DB_Layer SHALL return results within 50 milliseconds for databases with up to 1,000 chains
4. THE DB_Layer SHALL support filtering jobs by time range (last 24 hours, last 7 days) using indexed timestamp queries with ≤50ms response time
5. WHEN aggregating job counts by status, THE DB_Layer SHALL return results within 100 milliseconds for databases with up to 10,000 jobs
6. IF the database file is missing, THEN THE DB_Layer SHALL log warning "database file not found at <path>, falling back to file scanning"; THE warning SHALL be logged regardless of whether file scanning fallback occurs; IF fallback fails OR takes longer than expected, THE DB_Layer SHALL log additional diagnostic information including attempted fallback actions and their outcomes
7. IF a connection to PostgreSQL fails, THEN THE DB_Layer SHALL log error "PostgreSQL connection failed: <reason>" and fall back to file scanning; IF fallback fails OR takes longer than expected, THE DB_Layer SHALL log additional diagnostic information including attempted fallback actions and their outcomes

### Requirement 9: Historical Status Tracking

**User Story:** As a dashboard user, I want to see job status history, so that I can understand when and why jobs failed or succeeded.

#### Acceptance Criteria

1. WHEN a job status changes, THE DB_Layer SHALL insert a record into job_status_history with old status, new status, and timestamp; IF insert fails, THE system SHALL log error "status history insert failed: <reason>" and continue operation
2. IF a job transitions to "error" or "failed" state, THEN THE Status_History_Record SHALL preserve the failure reason in a dedicated `reason` column
3. THE Job_Status_History_Table SHALL retain at least 30 days of status change records
4. WHEN querying status history for a job, THE DB_Layer SHALL return results ordered by timestamp descending
5. THE Status_History_API SHALL expose `GET /api/status-history/:jobId` returning `{jobId, transitions: [{oldStatus, newStatus, timestamp, reason}]}`; IF jobId does not exist, return 404 with `{error: "job not found"}`

### Requirement 10: Database Migration System

**User Story:** As a developer, I want schema versioning, so that future database changes can be applied safely without data loss.

#### Acceptance Criteria

1. WHEN the migration system starts and schema_version table does not exist, THE Migration_System SHALL create it and initialize version to 0
2. THE Migration_System SHALL discover migration files matching pattern `migrations/<version>_<name>.sql` sorted numerically by version
3. WHEN the code expects schema version N but the database has version M < N, THE Migration_System SHALL apply migrations M+1 through N sequentially; WHEN M equals N, THE Migration_System SHALL skip all migrations
4. WHEN a migration fails, THE Migration_System SHALL roll back the transaction for that migration only, log error "migration <N> failed: <reason>", and refuse to start the server
5. THE Migration_System SHALL record each applied migration version and timestamp in the schema_version table within the same transaction as the migration
6. THE Migration_System SHALL apply all pending migrations during startup, before starting the HTTP server, with total migration time ≤10 seconds; THE server SHALL start only when all migrations complete successfully within the time limit; IF any migration fails, THE server SHALL not start even if the overall process completes within the time limit

### Requirement 11: Hybrid File-Database Architecture

**User Story:** As a system administrator, I want files to remain the source of truth, so that the database can be rebuilt if corrupted.

#### Acceptance Criteria

1. THE File_Scanner functions (scanJobs, scanChains, scanSessions) SHALL continue to operate when DB_ENABLED=false
2. WHEN the database is empty on first run, THE DB_Sync_Tool SHALL perform a full file scan and populate all tables within 30 minutes for workspaces with up to 10,000 files
3. THE DB_Sync_Tool SHALL compare file modification times against database `last_modified` timestamps to determine which files need updating
4. IF a database record exists but the source file is missing, THEN THE DB_Sync_Tool SHALL set the record's `deleted_at` timestamp (soft delete)
5. WHEN switching from file-only mode to database mode, THE DB_Sync_Tool SHALL populate the database from existing files without data loss
6. WHEN DB_ENABLED changes, THE server SHALL log "DB_ENABLED change requires server restart to take effect safely" whenever a restart is required; IF configuration propagates successfully to all components, THE server SHALL still log the restart message; IF no restart is required, no restart message SHALL be logged

### Requirement 12: Performance Metrics Collection

**User Story:** As a developer, I want to track job performance metrics, so that I can identify slow operations and optimize workflows.

#### Acceptance Criteria

1. WHEN a job completes (status becomes "done" OR "error"), THE Metrics_Collector SHALL extract duration, token counts, and cost from the job log
2. THE Job_Metrics_Table SHALL store duration_ms, input_tokens, output_tokens, total_tokens, and cost_usd for each job
3. WHEN a job log contains tool call counts, THE Metrics_Collector SHALL extract and store the tool_calls count; THE Metrics_Collector MAY extract tool call data before job completion if available in intermediate states
4. WHEN a job log contains retry information OR error information (either one present), THE Metrics_Collector SHALL extract and store `retry_count` and `error_count` fields
5. IF job log parsing fails for structural reasons (e.g. malformed JSON), THEN THE Metrics_Collector SHALL fail the entire collection process for that job; IF a field is missing or cannot be individually extracted, THEN THE Metrics_Collector SHALL store NULL for that field and log warning "metric extraction failed for <jobId>: <field>: <reason>", without failing collection for other fields
6. THE Metrics_Collector SHALL enforce numeric bounds: duration_ms ≥ 0, input_tokens ≥ 0, output_tokens ≥ 0, total_tokens ≥ 0, cost_usd ≥ 0, retry_count ≥ 0, error_count ≥ 0

### Requirement 13: Performance Analytics Computation

**User Story:** As a dashboard user, I want to see performance trends, so that I can understand if agents are getting faster or slower over time.

#### Acceptance Criteria

1. WHEN querying performance metrics, THE Analytics_Engine SHALL compute average, median, p95, and p99 duration for the specified time range
2. IF a time range filter has start > end, THEN THE Analytics_API SHALL return HTTP 400 with error "invalid time range: start must be <= end"
3. THE Performance_Metrics_API SHALL support time range filters (24h, 7d, 30d)
4. WHEN computing throughput, THE Analytics_Engine SHALL calculate jobs per hour and jobs per day from job timestamps
5. WHEN computing success rate for a time range with zero jobs, THE Analytics_Engine SHALL return NULL (not 0% or 100%); WHEN there are zero jobs in a time range, THE Analytics_Engine SHALL return NULL for all metrics including average, median, p95, and p99 duration; WHEN there are one or more jobs (positive job count), THE Analytics_Engine SHALL compute actual values for all metrics without returning NULL
6. WHEN comparing metrics across time periods, THE Analytics_Engine SHALL define the comparison window as the prior period of equivalent length (e.g., 7d compares to previous 7d); comparison windows SHALL only be defined for valid time ranges (start ≤ end)
7. THE Performance_Metrics_API SHALL cache computed metrics for 5 minutes to reduce database load, with all timestamps in UTC

### Requirement 14: Cost Analytics Computation

**User Story:** As a project manager, I want to track API costs, so that I can budget and optimize agent usage.

#### Acceptance Criteria

1. WHEN querying cost metrics for a time range, THE Analytics_Engine SHALL sum total_tokens and cost_usd across all jobs in that range
2. WHEN computing cost per job, THE Analytics_API SHALL divide total cost by total job count; IF job count is zero, return NULL
3. WHEN grouping costs by model, THE Analytics_Engine SHALL sum costs per agent/model name
4. WHEN projecting monthly cost, THE Cost_Analytics_API SHALL compute daily average over the selected time range and multiply by 30
5. WHEN identifying wasted cost, THE Analytics_Engine SHALL sum costs of jobs with status "error"
6. WHEN querying cost by workspace, THE Cost_By_Workspace_Query SHALL aggregate cost_usd, total_tokens, and job_count per workspace_id
7. WHEN computing daily cost trend, THE Daily_Cost_Trend_Query SHALL group costs by date for time series visualization

### Requirement 15: Bottleneck Detection

**User Story:** As a developer, I want to identify slow operations, so that I can focus optimization efforts on high-impact areas.

#### Acceptance Criteria

1. WHEN analyzing bottlenecks for a job type, THE Bottleneck_Detector SHALL identify jobs with duration more than 2 times the average for their type (slowdown_factor = job_duration / avg_duration_for_type); jobs NOT meeting the bottleneck threshold (slowdown_factor < 2) SHALL be explicitly marked as non-bottlenecks
2. WHEN returning slowest jobs, THE Slowest_Jobs_Query SHALL return the top 10 slowest jobs with duration, average for type, and slowdown factor; only jobs with positive slowdown_factor (slowdown_factor > 0) SHALL be included
3. IF tool call timing data is available AND concurrent job count ≥ 5, THEN THE Bottleneck_Detector SHALL identify tools with highest total time and call count
4. WHEN analyzing tool performance, THE Bottleneck_Analysis_API SHALL return the top 10 tools by total time, each with percent of total time and call count; tools with zero or negative call counts SHALL be excluded from analysis
5. WHEN detecting resource contention, THE Bottleneck_Detector SHALL identify periods with high concurrent job counts (threshold: ≥5 concurrent jobs)
6. WHEN generating recommendations, THE Recommendations_Engine SHALL only generate recommendations for jobs that are actual bottlenecks (slowdown_factor ≥ 2); THE recommendation format SHALL be: "Job type X is <slowdown_factor>x slower than average (<avg_duration>ms avg, <actual_duration>ms observed) - investigate <tool_name> (占用 <percent>% of total time)"
7. THE Bottleneck_Analysis_API SHALL assign severity: "high" if slowdown_factor ≥ 5, "medium" if 2 ≤ slowdown_factor < 5, "low" if slowdown_factor < 2

### Requirement 16: Predictive Analytics

**User Story:** As a dashboard user, I want estimated completion times for running jobs, so that I can plan my work accordingly.

#### Acceptance Criteria

1. WHEN a job is running AND there are ≥5 historical completed jobs of the same type, THE Predictive_Engine SHALL estimate remaining time as (average_duration_for_type - elapsed_time)
2. WHEN computing confidence score, THE Completion_Time_Estimator SHALL calculate it whenever coefficient of variation (CV = stddev / mean) is calculated; confidence_score = max(0, 1 - CV), strictly capping at 0 for any CV ≥ 1.0 without allowing negative intermediate values to propagate
3. IF the coefficient of variation for a job type's historical durations is > 0.5 AND other reliability conditions are met, THEN THE Predictive_Engine SHALL flag the estimate as low confidence
4. WHEN estimating success probability, THE Success_Probability_Estimator SHALL compute likelihood of success based on historical success rate for that job type
5. IF a running job's duration exceeds 2x the average, THEN THE Predictive_Engine SHALL flag it as anomalous
6. THE Anomaly_Detector SHALL compute an anomaly score (0-100) based on deviation from historical patterns
7. IF there are zero completed jobs of the same type, THEN THE Predictive_Engine SHALL return NULL for all estimates (cold-start behavior); IF there are fewer than 5 completed jobs of the same type, THEN THE Predictive_Engine SHALL return NULL for all estimates

### Requirement 17: Analytics Dashboard Integration

**User Story:** As a dashboard user, I want visual charts and graphs, so that I can quickly understand performance trends and issues.

#### Acceptance Criteria

1. THE Analytics_Dashboard_Page SHALL display performance metrics including average duration (ms), throughput (jobs/minute), and success rate (percentage)
2. THE Cost_Breakdown_Chart SHALL display cost per model as a bar chart (not pie chart)
3. THE Duration_Trend_Chart SHALL visualize average job duration over time as a line chart
4. WHEN a user selects a time range (24h, 7d, 30d), THE Analytics_Dashboard SHALL update all charts within 500ms; IF the update cannot complete within 500ms for oversized datasets OR under heavy load, THE Analytics_Dashboard SHALL show loading indicators and disable interactions until the update completes
5. WHEN a user clicks on a chart data point, THE Analytics_Dashboard SHALL drill down to show the underlying job list filtered by workspace_id, time_range, and status (if applicable)
6. WHEN a job completes, THE WebSocket_Broadcaster SHALL send metric update messages to subscribed clients within 2 seconds
7. THE Chart_Library SHALL render charts within 500 milliseconds for datasets with up to 1,000 data points; THE Chart_Library SHALL render empty charts or placeholder content when there are zero data points

### Requirement 18: Analytics API Endpoints

**User Story:** As a frontend developer, I want RESTful analytics endpoints, so that I can retrieve metrics for display in the dashboard.

#### Acceptance Criteria

1. THE Analytics_API SHALL expose `GET /api/analytics/performance` returning PerformanceMetrics for the specified workspace and time range with ≤200ms response time
2. THE Analytics_API SHALL expose `GET /api/analytics/cost` returning CostMetrics for the specified workspace and time range
3. THE Analytics_API SHALL expose `GET /api/analytics/bottlenecks` returning BottleneckAnalysis for the specified workspace
4. THE Analytics_API SHALL expose `GET /api/analytics/predictions` returning PredictiveMetrics for a specified job ID
5. IF the `range` parameter contains an invalid value, THEN THE Analytics_API SHALL return HTTP 400 with error "invalid range: must be one of [24h, 7d, 30d]"; ALL analytics endpoints that use the `range` parameter SHALL validate it and return this error for invalid values
6. IF the `workspace` parameter specifies a non-existent workspace ID, THEN THE Analytics_API SHALL return HTTP 404 with error "workspace not found"; IF the workspace exists but access is denied, THEN THE Analytics_API SHALL return HTTP 403 with error "access denied"; ALL analytics endpoints SHALL validate the `workspace` parameter and return these errors appropriately
7. IF a job ID parameter specifies a non-existent job, THEN THE Analytics_API SHALL return HTTP 404 with error "job not found"; ALL analytics endpoints SHALL validate job ID parameters and return this error for non-existent jobs


### Requirement 19: Analytics Export

**User Story:** As a data analyst, I want to export metrics to CSV or JSON, so that I can perform custom analysis in external tools.

#### Acceptance Criteria

1. THE Analytics_Export_API SHALL expose `GET /api/analytics/export`; IF the `type` parameter is missing or not in ["csv", "json"], return HTTP 400 with error "invalid or missing type parameter: must be 'csv' or 'json'"
2. WHEN exporting to CSV, THE Export_Formatter SHALL generate valid CSV with headers and quoted string fields, and set Content-Type to `text/csv`; CSV formatting SHALL only execute when the format parameter is "csv" and SHALL NOT run for JSON export requests
3. WHEN exporting to JSON, THE Export_Formatter SHALL generate valid JSON conforming to the metric type schemas, and set Content-Type to `application/json`
4. THE Analytics_Export_API SHALL support `metrics` query parameter to select which metric types to export (performance, cost, bottlenecks); IF an unrecognized metric type is provided, return HTTP 400 with error "unrecognized metric type: <type>"
5. THE Export_Response SHALL include appropriate Content-Type and Content-Disposition headers for browser download
6. WHEN filtering by date range with `from` and `to` parameters (ISO 8601 timestamps), IF `from` > `to`, THE Analytics_Export_API SHALL return HTTP 400 with error "invalid date range: from must be <= to"
7. FOR ALL exported data, the metric type schemas SHALL define: PerformanceMetrics = {avg_duration_ms, median_duration_ms, p95_duration_ms, p99_duration_ms, throughput_per_hour, success_rate_percent}; CostMetrics = {total_cost_usd, total_tokens, cost_per_job_usd, jobs_count}; BottleneckAnalysis = {job_id, duration_ms, slowdown_factor, severity}

### Requirement 20: Configuration and Environment Variables

**User Story:** As a system administrator, I want to configure database and analytics settings via environment variables, so that I can customize behavior without code changes.

#### Acceptance Criteria

1. THE Configuration_Loader SHALL support `DB_ENABLED` environment variable parsing "true"/"false" case-insensitively (exactly these strings); any other value SHALL log error "DB_ENABLED must be 'true' or 'false', got '<value>'" and abort startup
2. THE Configuration_Loader SHALL support `DB_TYPE` environment variable (sqlite or postgres, default: sqlite)
3. THE Configuration_Loader SHALL support `DB_PATH` environment variable for SQLite file path (default: .agenthq.db)
4. WHERE DB_TYPE is postgres AND `DB_URL` environment variable is missing, THE Configuration_Loader SHALL log error "DB_URL is required when DB_TYPE=postgres" and abort startup; THE server SHALL abort even if the error logging step itself fails
5. THE Configuration_Loader SHALL support `ANALYTICS_ENABLED` environment variable (true/false, default: true)
6. THE Configuration_Loader SHALL support `ANALYTICS_CACHE_TTL` environment variable in seconds (range: 1-86400, default: 300); IF value is outside range, THE Configuration_Loader SHALL clamp it to the nearest valid value (1 or 86400) and log warning "ANALYTICS_CACHE_TTL <value> adjusted to <clamped_value>"
7. THE Configuration_Loader SHALL support `WS_ENABLED` environment variable (true/false, default: true)
8. THE Configuration_Loader SHALL validate all environment variables on startup and log error messages in format "Configuration error: <variable_name>: <specific_issue>" for invalid values; WHEN validation errors occur for critical variables (DB_ENABLED, DB_URL when DB_TYPE=postgres), THE Configuration_Loader SHALL log the error AND abort startup

### Requirement 21: Backward Compatibility

**User Story:** As an existing AgentHQ user, I want the upgrade to be seamless, so that I don't need to change my workflow or configuration.

#### Acceptance Criteria

1. THE AgentHQ_Monitor SHALL continue to support SSE via the `/events` endpoint when WS_ENABLED is true
2. THE File_Scanner SHALL continue to function regardless of the DB_ENABLED setting value (true or false)
3. THE Existing_API_Endpoints SHALL return identical response formats after the upgrade (jobs, chains, sessions); specifically, GET /api/jobs SHALL return Job[] with {id, status, workspace, chain, timestamp, ...} matching current GitCommitResult type structure
4. WHEN upgrading from a previous version, THE Monitor SHALL initialize the database from existing files fully automatically with zero manual steps
5. THE Dashboard_Frontend SHALL gracefully degrade to SSE if the WebSocket connection fails; specifically, WebSocket constructor failure or close event SHALL trigger fallback to EventSource with configurable reconnection parameters (default: retry 1000ms, max 5 attempts, overridable via environment or config)
6. THE Configuration SHALL default to backward-compatible settings (DB_ENABLED=true but falls back to files on error)
7. THE Existing_Git_Integration SHALL continue to work unchanged via POST /git-commit

### Requirement 22: Error Handling and Resilience

**User Story:** As a system administrator, I want the system to handle errors gracefully, so that partial failures don't crash the entire monitor.

#### Acceptance Criteria

1. IF the database connection fails, THEN THE DB_Layer SHALL fall back to file-based scanning and log a warning
2. IF a WebSocket client sends a message that fails JSON.parse, THEN THE Message_Handler SHALL log error "WebSocket message parse failed: <error.message>" and close the connection with code 1003
3. IF a file watcher encounters a parse error, THEN THE File_Watcher SHALL log the error and continue monitoring other files
4. IF an analytics query exceeds 30 seconds, THEN THE Analytics_API SHALL abort the query and return HTTP 503 with error "computation timed out after 30 seconds"; HTTP 503 SHALL only be returned for timeout scenarios, not for other error conditions such as resource exhaustion or invalid query syntax
5. WHEN computing disk usage, THE DB_Layer SHALL calculate current_db_size / available_disk_space; IF ratio ≥ 0.9, log critical warning "Database approaching disk limit: <percent>% used"
6. IF a migration fails, THEN THE Migration_System SHALL roll back the transaction and preserve the previous schema version
7. THE WebSocket_Server SHALL automatically close and clean up connections that have been idle (no messages sent or received in either direction) for more than 60 seconds

### Requirement 23: Logging and Observability

**User Story:** As a developer, I want detailed logs, so that I can diagnose issues and monitor system health.

#### Acceptance Criteria

1. THE WebSocket_Server SHALL log all connection events (connect, disconnect, error) with fields: {level, event_type, client_id, timestamp, remote_ip}
2. THE DB_Layer SHALL log query execution times exceeding 100 milliseconds (not equal to 100ms) with fields: {level, query_type, duration_ms, table_name, filter_conditions}
3. THE File_Watcher SHALL log file change events with file path, event type, and processing duration
4. WHEN cache_logging_enabled is true AND log level is INFO or higher, THE Analytics_Engine SHALL log cache hit/miss rates every 5 minutes
5. THE Command_Handler SHALL log all user commands with fields: {level, user_id, command_type, target_entity_id, execution_result, duration_ms}
6. THE Migration_System SHALL log all applied migrations with version number and execution duration
7. THE Error_Logger SHALL include stack traces with severity levels (DEBUG < INFO < WARN < ERROR < FATAL) for all unexpected errors (errors not matching known error patterns in validation or user input handling)

### Requirement 24: Security and Validation

**User Story:** As a security-conscious developer, I want input validation and safe database queries, so that the system is protected from injection attacks.

#### Acceptance Criteria

1. THE Query_Builder SHALL use parameterized queries for all user-provided input to prevent SQL injection
2. THE WebSocket_Message_Validator SHALL reject messages with unexpected fields or invalid types
3. WHEN the system is executing commands, THE Command_Handler SHALL validate that workspace IDs in commands match existing workspaces before execution
4. THE File_Watcher SHALL sanitize file paths to prevent directory traversal attacks by rejecting paths containing ".." segments OR path separators that would escape the monitored directory
5. THE Analytics_Export_API SHALL validate and sanitize the `metrics` parameter to prevent arbitrary file access by accepting only values from the enum ["performance", "cost", "bottlenecks"]
6. THE Database_Connection_String SHALL not be logged in error messages or stack traces; IF connection fails, log only "database connection failed" without exposing host, port, username, or password from DB_URL or DB_PATH
7. THE WebSocket_Server SHALL enforce a maximum message size of 1MB payload, with tolerance allowed for protocol-level overhead such as headers and framing metadata; messages slightly above 1MB (within reasonable protocol overhead buffer) SHALL be accepted

### Requirement 25: Testing and Verification

**User Story:** As a developer, I want comprehensive tests, so that I can refactor with confidence and catch regressions early.

#### Acceptance Criteria

1. THE Test_Suite SHALL include unit tests for all database operations (insert, update, query, delete)
2. THE Test_Suite SHALL include property-based tests for round-trip serialization of WebSocket messages
3. THE Test_Suite SHALL include integration tests for WebSocket flows (connect, subscribe, command, broadcast)
4. THE Test_Suite SHALL include property-based tests for analytics calculations: all duration/cost metrics ≥ 0, success_rate_percent in range [0, 100], retry_count ≥ 0, error_count ≥ 0
5. THE Test_Suite SHALL include performance tests verifying query response times: workspace+status filter queries ≤50ms, time-range filter queries ≤50ms, aggregation queries ≤100ms; THE performance tests MUST pass for the test suite to be considered complete; IF performance tests are missing, THE test suite SHALL be treated as failing and prevent completion until the tests are implemented
6. THE Test_Suite SHALL include tests verifying database fallback: WHEN database is unavailable (file missing OR connection failure), file-scan layer SHALL return valid results
7. THE Test_Suite SHALL include tests for concurrent WebSocket connections: ≥10 concurrent connections sending commands simultaneously SHALL all receive acknowledgements with ≤500ms latency and correct results
