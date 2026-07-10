# Requirements Document

## Introduction

This document specifies requirements for adding a persistent database layer to AgentHQ. The enhancement adds SQLite/PostgreSQL support for fast indexed queries, historical status tracking, and efficient time-range analytics, while maintaining files as the source of truth.

The current system uses file-based storage with in-memory TTL caches (5-10s expiry). This prevents efficient time-range queries, historical trend analysis, and fast filtered searches across large datasets.

## Glossary

- **AgentHQ**: Developer agent monitoring dashboard built with Bun, TypeScript, and file-based storage
- **Workspace**: Monitored Kiro agent execution environment with dedicated output/session directories
- **Job**: Agent execution instance with status, logs, and metrics (type: Job)
- **Chain**: Sequence of related sessions grouped by topic (type: Chain)
- **Session**: Kiro conversation state snapshot (type: SessionState)
- **Scanner**: File system reading functions in src/scan/ (jobs.ts, chains.ts, sessions.ts)
- **DB_Layer**: Database abstraction interface supporting SQLite and PostgreSQL
- **SQLite**: Embedded SQL database (zero-config, single-file, ACID-compliant)
- **PostgreSQL**: Client-server SQL database (production-grade, multi-user)
- **WAL_Mode**: Write-Ahead Logging mode for SQLite (improves concurrency)
- **DbAdapter**: Interface abstracting database operations (query, execute, transaction, close)
- **Migration**: Versioned SQL script applying schema changes

## Requirements

### Requirement 1: Database Schema and Storage

**User Story:** As a system administrator, I want a persistent database layer, so that queries are fast and historical data is preserved.

#### Acceptance Criteria

1. THE DB_Layer SHALL support SQLite with zero configuration (no environment variables required beyond DB_PATH)
2. WHERE PostgreSQL is configured, THE DB_Layer SHALL support PostgreSQL as an alternative database engine; IF PostgreSQL drivers or libraries are unavailable at runtime, THE DB_Layer SHALL fail gracefully with a clear error message indicating the missing dependency
3. THE Database_Schema SHALL include tables for workspaces, jobs, chains, sessions, job_status_history, and job_metrics
4. WHEN the database is initialized, THE Migration_System SHALL first create all tables, THEN create all indexes (indexes SHALL NOT be created before the tables they reference exist), and all operations SHALL complete idempotently (safe to run multiple times); IF any table creation step fails, THE Migration_System SHALL fail the entire migration without proceeding to index creation; IF any index creation step fails after tables succeed, THE Migration_System SHALL fail the migration
5. THE Database_Schema SHALL define foreign key constraints between jobs/chains/sessions and their workspaces
6. WHEN database initialization completes AND the active adapter is SQLite, THE SQLite_Adapter SHALL enable WAL mode for improved concurrency; WHERE PostgreSQL is the active adapter, WAL mode configuration SHALL be skipped entirely
7. THE Schema_Version_Table SHALL track the current schema version for migration management
8. IF database connection fails, THEN THE DB_Layer SHALL log error "database connection failed: <reason>" and fall back to file scanning

### Requirement 2: File System Watchers

**User Story:** As a developer, I want the database to update automatically when files change, so that I don't need to manually trigger rescans.

#### Acceptance Criteria

1. WHEN a job markdown file is created or modified AND the file parses successfully, THE Job_Watcher SHALL upsert the job record within 1 second
2. IF a file fails to parse for any reason (missing fields, malformed JSON, structural issues), THEN THE File_Watcher SHALL log error "parse failed: <path>: <reason>", the database state SHALL remain unchanged, and no upsert operation SHALL be attempted; WHEN the parsing failure is unrecoverable and requires manual intervention, THE File_Watcher SHALL send admin notifications OR quarantine the file; IF a file is deleted while parsing is in progress, THE File_Watcher SHALL allow parsing to complete on the in-memory content already read and proceed with normal upsert logic
3. IF a file is parsed successfully but database upsert fails, THEN THE File_Watcher SHALL immediately schedule a retry attempt, log error "upsert failed: <path>: <db_error>", and retry on next file change
4. WHEN a file is deleted, THE File_Watcher SHALL mark the corresponding database record as deleted (soft delete) within 1 second
5. THE File_Watcher SHALL debounce rapid file changes: IF multiple saves occur within 500ms, THEN only the last write SHALL trigger a database update
6. WHEN the monitor starts, THE File_Watcher SHALL perform an initial full scan within 30 seconds before starting incremental updates; IF the initial scan cannot complete within 30 seconds due to file count exceeding processing capacity OR timeout expiration, THE File_Watcher SHALL fail startup and require manual intervention to reduce the file count OR increase the timeout
7. IF two files with the same job ID but different content are detected, THEN THE File_Watcher SHALL use the file with the most recent modification time

### Requirement 3: Database Query Performance

**User Story:** As a dashboard user, I want queries to return results quickly, so that the dashboard feels responsive.

#### Acceptance Criteria

1. WHEN querying jobs filtered by workspace and status with an appropriate index, THE DB_Layer SHALL return results within 75 milliseconds for databases with fewer than 8,000 jobs
2. WHEN querying jobs sorted by timestamp descending, THE DB_Layer SHALL use the `idx_workspace_timestamp` index for efficient retrieval
3. WHEN querying chains by workspace ordered by last active time, THE DB_Layer SHALL return results within 50 milliseconds for databases with fewer than 1,000 chains
4. THE DB_Layer SHALL support filtering jobs by time range (last 24 hours, last 7 days) using indexed timestamp queries with ≤50ms response time
5. WHEN aggregating job counts by status, THE DB_Layer SHALL return results within 100 milliseconds for databases with fewer than 10,000 jobs
6. IF the database file is missing, THEN THE DB_Layer SHALL log warning "database file not found at <path>, falling back to file scanning"; THE warning SHALL be logged regardless of whether file scanning fallback occurs; IF fallback fails OR takes longer than expected, THE DB_Layer SHALL log additional diagnostic information including attempted fallback actions and their outcomes
7. IF a connection to PostgreSQL fails, THEN THE DB_Layer SHALL log warning "PostgreSQL connection failed: <reason>, falling back to file scanning"; THE warning SHALL be logged regardless of whether the database file exists; IF fallback fails OR takes longer than expected, THE DB_Layer SHALL log additional diagnostic information including attempted fallback actions and their outcomes
7. IF a connection to PostgreSQL fails, THEN THE DB_Layer SHALL log error "PostgreSQL connection failed: <reason>" and fall back to file scanning; IF fallback fails OR takes longer than expected, THE DB_Layer SHALL log additional diagnostic information including attempted fallback actions and their outcomes

### Requirement 4: Historical Status Tracking

**User Story:** As a dashboard user, I want to see job status history, so that I can understand when and why jobs failed or succeeded.

#### Acceptance Criteria

1. WHEN a job status changes, THE DB_Layer SHALL insert a record into job_status_history with old status, new status, and timestamp; IF insert fails, THE system SHALL log error "status history insert failed: <reason>" and continue operation
2. IF a job transitions to "error" or "failed" state, THEN THE Status_History_Record SHALL preserve the failure reason in a dedicated `reason` column
3. THE Job_Status_History_Table SHALL retain at least 30 days of status change records
4. WHEN querying status history for a job, THE DB_Layer SHALL return results ordered by timestamp descending
5. THE Status_History_API SHALL expose `GET /api/status-history/:jobId` returning `{jobId, transitions: [{oldStatus, newStatus, timestamp, reason}]}`; IF jobId does not exist, return 404 with `{error: "job not found"}`

### Requirement 5: Database Migration System

**User Story:** As a developer, I want schema versioning, so that future database changes can be applied safely without data loss.

#### Acceptance Criteria

1. WHEN the migration system starts and schema_version table does not exist, THE Migration_System SHALL create it and initialize version to 0
2. THE Migration_System SHALL discover migration files matching pattern `migrations/<version>_<name>.sql` sorted numerically by version
3. WHEN the code expects schema version N but the database has version M < N, THE Migration_System SHALL apply migrations M+1 through N sequentially; WHEN M equals N, THE Migration_System SHALL skip all migrations
4. WHEN a migration fails, THE Migration_System SHALL roll back the transaction for that migration only, log error "migration <N> failed: <reason>", and refuse to start the server; IF the rollback operation itself fails, THE Migration_System SHALL accept the resulting inconsistent schema state and log error "migration <N> rollback failed: <reason>" before refusing to start the server
5. THE Migration_System SHALL record each applied migration version and timestamp in the schema_version table within the same transaction as the migration
6. THE Migration_System SHALL apply all pending migrations during startup, before starting the HTTP server, with total migration time ≤10 seconds; THE server SHALL start only when all migrations complete successfully within the time limit; IF any migration fails, THE server SHALL not start regardless of whether the overall process completes within the time limit or other conditions are met

### Requirement 6: Hybrid File-Database Architecture

**User Story:** As a system administrator, I want files to remain the source of truth, so that the database can be rebuilt if corrupted.

#### Acceptance Criteria

1. THE File_Scanner functions (scanJobs, scanChains, scanSessions) SHALL continue to operate when DB_ENABLED=false
2. WHEN the database is empty on first run, THE DB_Sync_Tool SHALL perform a full file scan and populate all tables within 30 minutes for workspaces with up to 10,000 files
3. THE DB_Sync_Tool SHALL compare file modification times against database `last_modified` timestamps to determine which files need updating
4. IF a database record exists but the source file is missing, THEN THE DB_Sync_Tool SHALL set the record's `deleted_at` timestamp (soft delete)
5. WHEN switching from file-only mode to database mode, THE DB_Sync_Tool SHALL populate the database from existing files without data loss
6. WHEN DB_ENABLED changes, THE server SHALL log "DB_ENABLED change requires server restart to take effect safely"; THE restart message SHALL be logged whenever DB_ENABLED changes OR whenever configuration propagation fails, regardless of whether a restart is technically required

### Requirement 7: Configuration and Environment Variables

**User Story:** As a system administrator, I want to configure database settings via environment variables, so that I can customize behavior without code changes.

#### Acceptance Criteria

1. THE Configuration_Loader SHALL support `DB_ENABLED` environment variable parsing "true"/"false" case-insensitively (exactly these strings); any other value SHALL log error "DB_ENABLED must be 'true' or 'false', got '<value>'" and abort startup
2. THE Configuration_Loader SHALL support `DB_TYPE` environment variable (sqlite or postgres, default: sqlite)
3. THE Configuration_Loader SHALL support `DB_PATH` environment variable for SQLite file path (default: .agenthq.db)
4. WHERE DB_TYPE is postgres AND `DB_URL` environment variable is missing, THE Configuration_Loader SHALL log error "DB_URL is required when DB_TYPE=postgres" and abort startup; THE server SHALL abort startup regardless of whether the error logging step itself succeeds or fails
5. THE Configuration_Loader SHALL validate all environment variables on startup and log error messages in format "Configuration error: <variable_name>: <specific_issue>" for invalid values; WHEN validation errors occur for critical variables (DB_ENABLED, DB_URL when DB_TYPE=postgres), THE Configuration_Loader SHALL log the error AND abort startup

### Requirement 8: Backward Compatibility

**User Story:** As an existing AgentHQ user, I want the upgrade to be seamless, so that I don't need to change my workflow or configuration.

#### Acceptance Criteria

1. THE File_Scanner SHALL continue to function regardless of the DB_ENABLED setting value (true or false); IF the underlying file system encounters errors during database fallback operations, THE File_Scanner SHALL allow those errors to propagate and fail normally
2. THE Existing_API_Endpoints SHALL return identical response formats after the upgrade (jobs, chains, sessions); specifically, GET /api/jobs SHALL return Job[] with {id, status, workspace, chain, timestamp, ...} matching current structure
3. WHEN upgrading from a previous version, THE Monitor SHALL initialize the database from existing files fully automatically with zero manual steps
4. THE Configuration SHALL default to backward-compatible settings (DB_ENABLED=true but falls back to files on error); WHEN DB_ENABLED=true and the database is initializing, THE Monitor SHALL block all incoming API requests until database initialization completes before serving any responses

### Requirement 9: Error Handling and Resilience

**User Story:** As a system administrator, I want the system to handle errors gracefully, so that partial failures don't crash the entire monitor.

#### Acceptance Criteria

1. IF the database connection fails, THEN THE DB_Layer SHALL fall back to file-based scanning and log a warning
2. IF a file watcher encounters a parse error, THEN THE File_Watcher SHALL log the error and continue monitoring other files
3. WHEN computing disk usage, THE DB_Layer SHALL calculate current_db_size / available_disk_space; IF ratio ≥ 0.9, THE DB_Layer SHALL log critical warning "Database approaching disk limit: <percent>% used"; THE DB_Layer SHALL NOT log errors or warnings for disk usage calculations where the ratio is below the 0.9 threshold
4. IF a migration fails, THEN THE Migration_System SHALL roll back the transaction and preserve the previous schema version; IF the rollback itself fails, THE Migration_System SHALL accept the inconsistent state and log the rollback failure

### Requirement 10: Logging and Observability

**User Story:** As a developer, I want detailed logs, so that I can diagnose issues and monitor system health.

#### Acceptance Criteria

1. THE DB_Layer SHALL log query execution times exceeding 100 milliseconds (not equal to 100ms) with fields: {level, query_type, duration_ms, table_name, filter_conditions}
2. THE File_Watcher SHALL log file change events with file path, event type, and processing duration
3. THE Migration_System SHALL log all applied migrations with version number and execution duration
4. THE Error_Logger SHALL include stack traces with severity levels (DEBUG < INFO < WARN < ERROR < FATAL) for all unexpected errors

### Requirement 11: Security and Validation

**User Story:** As a security-conscious developer, I want input validation and safe database queries, so that the system is protected from injection attacks.

#### Acceptance Criteria

1. THE Query_Builder SHALL use parameterized queries for all user-provided input to prevent SQL injection
2. THE File_Watcher SHALL sanitize file paths to prevent directory traversal attacks by rejecting paths containing ".." segments OR path separators that would escape the monitored directory
3. THE Database_Connection_String SHALL not be logged in error messages or stack traces; IF connection fails, THE DB_Layer SHALL always log the safe message "database connection failed" without exposing host, port, username, or password from DB_URL or DB_PATH; THE safe message SHALL be logged on every connection failure without exception

### Requirement 12: Testing and Verification

**User Story:** As a developer, I want comprehensive tests, so that I can refactor with confidence and catch regressions early.

#### Acceptance Criteria

1. THE Test_Suite SHALL include unit tests for all database operations (insert, update, query, delete)
2. THE Test_Suite SHALL include performance tests verifying query response times for datasets below the maximum thresholds: workspace+status filter queries ≤75ms (fewer than 8,000 jobs), time-range filter queries ≤50ms (fewer than 1,000 chains), aggregation queries ≤100ms (fewer than 10,000 jobs); THE performance tests MUST pass for the test suite to be considered complete
3. THE Test_Suite SHALL include tests verifying database fallback: WHEN database is unavailable (file missing OR connection failure), file-scan layer SHALL return valid results
