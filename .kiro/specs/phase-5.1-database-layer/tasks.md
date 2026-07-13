# Implementation Plan: Phase 5.1 — Database Layer

## Skill Activation — REQUIRED before every task

**Call `disclose_context` for these skills before writing any code or tests:**

| Always | `accelint-ts-best-practices`, `accelint-ts-testing` |
|--------|------------------------------------------------------|
| + DB / backend / routes | `error-handling-patterns` |
| + dashboard / UI | `agenthq-dashboard` |
| + performance / query timing | `accelint-ts-performance` |
| + security / validation / SQL | `best-practices` |
| + JSDoc / comments | `accelint-ts-documentation` |
| + refactoring / coupling | `improve-codebase-architecture` |

These skills do NOT activate automatically during spec task execution.
`disclose_context` must be called explicitly at the start of each task.

---

## Overview

Implementation plan for the Phase 5.1 database layer. This phase adds SQLite/PostgreSQL
persistence behind the `DbAdapter` interface, a file-watcher-driven sync tool, migration
runner, status-history route, and startup gating — while keeping files as the source of truth.

All code is TypeScript targeting Bun. Tests use `bun test` + `fast-check`.

## Tasks

- [x] 1. Set up `src/config/db-config.ts` with `DbConfig` interface and `loadDbConfig()`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` and `disclose_context("error-handling-patterns")` before writing any code
  - Export `DbConfig` type: `{ enabled: boolean; type: 'sqlite' | 'postgres'; path: string; url?: string }`
  - Parse `DB_ENABLED` (case-insensitive "true"/"false" only; throw on any other value with message `"DB_ENABLED must be 'true' or 'false', got '<value>'"`)
  - Parse `DB_TYPE` (default `"sqlite"`); throw if value is not `"sqlite"` or `"postgres"`
  - Parse `DB_PATH` (default `".agenthq.db"`)
  - Throw `"DB_URL is required when DB_TYPE=postgres"` when type is postgres and `DB_URL` absent
  - Add `DB_ENABLED`, `DB_TYPE`, `DB_PATH`, `DB_URL` entries with comments to `.env.example`
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [x] 2. Write unit tests for `loadDbConfig()` in `test/config/db-config.test.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
  - Valid SQLite defaults; valid postgres with URL; missing DB_URL throws; bad DB_ENABLED throws
  - `DB_ENABLED="True"` (capital T) should succeed; `DB_ENABLED="yes"` should throw
  - Use `it('should ...')` sentence format for all test descriptions
  - _Requirements: 7.1, 7.4, 7.5, 12.1_

- [x] 3. Create `DbAdapter` interface, row types, and `createDbAdapter()` in `src/db/adapter.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` and `disclose_context("error-handling-patterns")` before writing any code
  - Define `DbAdapter`: `query<T>()`, `execute()`, `transaction()`, `close()`
  - Define `QueryResult<T>`, `ExecResult`
  - Define `DbJob`, `DbChain`, `DbSession`, `DbJobStatusHistory`, `SchemaVersion` row interfaces
  - `createDbAdapter(config)` routes to `SQLiteAdapter` or `PostgresAdapter`; calls `enableWal()` only for SQLite after construction
  - _Requirements: 1.1, 1.2, 1.6_

- [x] 4. Implement `SQLiteAdapter` in `src/db/sqlite-adapter.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` and `disclose_context("error-handling-patterns")` before writing any code
  - Constructor opens/creates DB file; runs `PRAGMA foreign_keys = ON`
  - `enableWal()` runs `PRAGMA journal_mode = WAL`
  - `query<T>()` uses `db.prepare().all()`; `execute()` uses `db.prepare().run()`
  - `transaction()` wraps `BEGIN` / `COMMIT` / `ROLLBACK`; re-throws on error
  - _Requirements: 1.1, 1.6, 11.1_

- [x] 5. Write unit tests for `SQLiteAdapter` in `test/db/sqlite-adapter.test.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
  - Insert + query round-trip; transaction commit; transaction rollback on error
  - `close()` then query throws; WAL pragma set after `enableWal()`
  - _Requirements: 12.1_

- [x] 6. Implement `PostgresAdapter` in `src/db/postgres-adapter.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` and `disclose_context("error-handling-patterns")` and `disclose_context("best-practices")` before writing any code
  - Lazy-load `pg` via `require('pg')` inside constructor to avoid crash when not installed
  - `query<T>()`, `execute()` delegate to `pool.query()`
  - `transaction()` acquires client, runs `BEGIN` / fn / `COMMIT`; releases in `finally`
  - On connection error, surface safe message — no URL, host, port, or credentials in log
  - _Requirements: 1.2, 11.3_

- [x] 7. Write unit tests for `PostgresAdapter` (mock `pg` pool) in `test/db/postgres-adapter.test.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
  - Successful query; transaction commit; transaction rollback; missing `pg` throws descriptive error
  - _Requirements: 1.2, 12.1_

- [x] 8. Create SQL DDL migration files
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("best-practices")` before writing any code
  - Create `migrations/001_initial.sql`: tables `schema_version`, `workspaces`, `jobs`, `chains`, `sessions`; all columns, CHECK constraints, DEFAULT values, FK constraints per design schema; five `CREATE INDEX IF NOT EXISTS` statements after all table definitions; use `CREATE TABLE IF NOT EXISTS` throughout (idempotent)
  - Create `migrations/002_status_history.sql`: table `job_status_history` (`id INTEGER PRIMARY KEY AUTOINCREMENT`, `job_id`, `workspace_id`, `old_status`, `new_status`, `reason` nullable, `changed_at`); index `idx_status_history_job ON job_status_history(job_id, changed_at DESC)`; use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
  - _Requirements: 1.3, 1.4, 1.5, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.3, 4.4_

- [x] 9. Implement `runMigrations()` in `src/db/migrations.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` and `disclose_context("error-handling-patterns")` before writing any code
  - Create `schema_version` table if absent; query `MAX(version)` for `currentVersion`
  - Discover `.sql` files matching `/^\d+_.*\.sql$/`, sorted numerically; skip version ≤ `currentVersion`
  - Apply each in a transaction; record version + timestamp in `schema_version` within same transaction
  - On failure: rollback; log `"migration <N> failed: <reason>"`; if rollback fails log `"migration <N> rollback failed: <reason>"`; throw in both cases
  - Enforce 10-second total wall-clock timeout; throw if exceeded
  - Log all applied migrations with version number and execution duration
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 10.3_

- [x] 10. Write property test for schema version coherence (Property 4) in `test/db/migrations.property.test.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
  - **Property 4: Schema Version Coherence**
  - Generate random subsets of already-applied migrations; assert `MAX(version)` never exceeds migration count and always increases monotonically
  - Use `fc.property` and `fc.assert` from `fast-check`
  - **Validates: Requirements 5.3, 5.5**

- [x] 11. Write unit tests for `runMigrations()` in `test/db/migrations.test.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
  - Fresh DB applies all; already-current skips all; partial DB applies remainder
  - Failure in N rolls back N but preserves N-1; timeout throws and prevents start
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 12.1_

- [x] 12. Implement `DbSyncTool` in `src/db/sync.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` and `disclose_context("error-handling-patterns")` and `disclose_context("best-practices")` before writing any code
  - `runFullSync(workspaceId)`: calls `scanJobs`, `scanChains`, `scanSessions`; upserts all in single transaction via `INSERT … ON CONFLICT DO UPDATE SET`
  - Sets `last_modified = Date.now()` on upsert; preserves existing `deleted_at` unless file is present
  - `syncFile(filePath)`: stats file; if absent sets `deleted_at`; if present parses and upserts
  - Path sanitization: reject paths containing `..` or separator sequences escaping monitored root
  - All queries parameterized — no string interpolation of file paths or user data
  - _Requirements: 2.1, 2.4, 2.5, 2.7, 6.1, 6.2, 6.3, 6.4, 6.5, 11.1, 11.2_

- [x] 13. Write property test for sync idempotence (Property 6) in `test/db/sync.property.test.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
  - **Property 6: File Sync Idempotence**
  - For arbitrary file content: `syncFile(P)` twice with no intervening writes must leave identical row state
  - Use `fc.property` and `fc.assert` from `fast-check`
  - **Validates: Requirements 6.3**

- [x] 14. Write property test for database-file consistency (Property 1) in `test/db/sync-consistency.property.test.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
  - **Property 1: Database-File Consistency**
  - After `syncFile(path)` with confirmed-absent path, assert `deleted_at IS NOT NULL` for that record
  - Use `fc.property` and `fc.assert` from `fast-check`
  - **Validates: Requirements 6.4, 2.4**

- [x] 15. Write unit tests for `DbSyncTool` in `test/db/sync.test.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
  - `runFullSync` populates empty DB; re-running does not duplicate rows
  - `syncFile` upserts changed file; `syncFile` soft-deletes missing file; path with `..` rejected
  - _Requirements: 2.1, 2.4, 6.3, 6.4, 11.2, 12.1_

- [x] 16. Create `src/workers/fileWatcher.ts` with `startFileWatcher(db, outputDir)`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` and `disclose_context("error-handling-patterns")` before writing any code
  - Trigger `syncTool.runFullSync(outputDir)` on startup; catch and log errors without throwing
  - Watch `outputDir` recursively using `fs.watch`
  - Debounce per-path at 500 ms via `Map<string, NodeJS.Timeout>`; clear and reset on each event
  - On debounce fire: call `syncTool.syncFile(path)` and catch/log errors
  - Log file change events with path, event type, and processing duration
  - _Requirements: 2.1, 2.4, 2.5, 2.6, 10.2_

- [x] 17. Write unit tests for debounce logic in `startFileWatcher` in `test/db/fileWatcher.test.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
  - Rapid events for same path → only one sync call after 500 ms
  - Events for distinct paths → independent debounce timers
  - _Requirements: 2.5, 12.1_

- [x] 18. Create `src/routes/status-history.ts` — `GET /api/status-history/:jobId`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` and `disclose_context("error-handling-patterns")` and `disclose_context("best-practices")` before writing any code
  - Export `register(router, db: DbAdapter)`
  - Query `job_status_history WHERE job_id = ? ORDER BY changed_at DESC` with parameterized query
  - Return `{ jobId, transitions: [{ oldStatus, newStatus, timestamp, reason }] }`
  - Return HTTP 404 `{ error: "job not found" }` when no rows exist for jobId
  - _Requirements: 4.4, 4.5, 11.1_

- [x] 19. Write unit tests for status-history route in `test/routes/status-history.test.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
  - Existing job with transitions returns ordered array; unknown jobId returns 404; empty history returns empty array (not 404)
  - _Requirements: 4.4, 4.5, 12.1_

- [x] 20. Checkpoint — run `bun test test/` and fix any failures before proceeding
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` before proceeding
  - Ensure all tests pass; ask the user if questions arise

- [x] 21. Integrate DB layer into `src/monitor.ts` — startup gating
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` and `disclose_context("error-handling-patterns")` before writing any code
  - Call `loadDbConfig(process.env)` at top; on config error log and `process.exit(1)` before `Bun.serve()`
  - If `DB_ENABLED=true`: `createDbAdapter`, run `runMigrations`, then serve; migration failure → `process.exit(1)`
  - Set module-level `dbReady: boolean = false`; flip to `true` after migrations complete
  - Register `status-history` route only when `DB_ENABLED=true`
  - Start `startFileWatcher(db, outputDir)` after `Bun.serve()` succeeds
  - Log `"DB_ENABLED change requires server restart to take effect safely"` on runtime change
  - _Requirements: 5.6, 6.6, 8.3, 8.4, 9.1_

- [x] 22. Add request-blocking middleware for DB initialization window
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` and `disclose_context("error-handling-patterns")` before writing any code
  - While `dbReady === false` and `DB_ENABLED=true`, all API routes return 503 `{ error: "initializing" }` except `/` and static assets
  - File-scan fallback routes remain available during init; once `dbReady=true` middleware is a no-op
  - _Requirements: 8.4_

- [x] 23. Write property test for request gate during initialization (Property 5) in `test/middleware/request-gate.property.test.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
  - **Property 5: Request Gate During Initialization**
  - Simulate requests while `dbReady=false`; assert none return DB-sourced data; assert all return 503 or file-scan result
  - Use `fc.property` and `fc.assert` from `fast-check`
  - **Validates: Requirements 8.4**

- [x] 24. Write integration test for full startup sequence in `test/integration/startup.test.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` and `disclose_context("error-handling-patterns")` before writing any code
  - Fresh DB: migrations run, `dbReady` flips true, watcher starts
  - Config error: `process.exit(1)` before `Bun.serve()`; migration failure: server never starts
  - _Requirements: 5.6, 8.3, 8.4, 9.1, 12.1_

- [ ] 25. Add disk-space monitoring and slow-query logging
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` and `disclose_context("accelint-ts-performance")` before writing any code
  - After each `runFullSync` compute `db_size / available_space`; log critical `"Database approaching disk limit: <percent>% used"` only when ratio ≥ 0.9
  - Wrap `query()` and `execute()` in both adapters with `performance.now()` timing; log `{ level: "WARN", query_type, duration_ms, table_name, filter_conditions }` when `duration_ms > 100`
  - _Requirements: 9.3, 10.1_

- [ ] 26. Write unit tests for all `DbAdapter` operations against in-memory SQLite in `test/db/adapter.test.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
  - Insert job row; update status; query by workspace+status; soft-delete; aggregate count
  - FK constraint rejects insert with unknown `workspace_id`
  - _Requirements: 1.5, 12.1_

- [ ] 27. Write property test for foreign-key integrity (Property 3) in `test/db/fk-integrity.property.test.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
  - **Property 3: Foreign Key Integrity**
  - Arbitrary job inserts with random `workspace_id`; assert insert without prior workspace is rejected
  - Use `fc.property` and `fc.assert` from `fast-check`
  - **Validates: Requirements 1.5**

- [ ] 28. Write property test for monotonic status-history timestamps (Property 2) in `test/db/monotonic-timestamps.property.test.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
  - **Property 2: Monotonic Status History Timestamps**
  - Insert N transitions in wall-clock order; assert `changed_at` values are non-decreasing ordered by `id`
  - Use `fc.property` and `fc.assert` from `fast-check`
  - **Validates: Requirements 4.1, 4.4**

- [ ] 29. Write property test for query result stability (Property 7) in `test/db/query-stability.property.test.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
  - **Property 7: Query Result Stability**
  - Run identical parameterized query twice with no intervening writes; assert identical result sets
  - Use `fc.property` and `fc.assert` from `fast-check`
  - **Validates: Requirements 3.1, 3.3, 3.5**

- [ ] 30. Write fallback resilience test in `test/db/fallback-resilience.test.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` and `disclose_context("error-handling-patterns")` before writing any code
  - `DB_ENABLED=false` or closed adapter: `scanJobs/scanChains/scanSessions` return valid arrays
  - Simulate DB unavailability; assert route falls back to file scan without throwing
  - _Requirements: 1.8, 3.6, 8.1, 9.1, 12.3_

- [ ] 31. Write performance tests for indexed query bounds in `test/db/performance.test.ts`
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` and `disclose_context("accelint-ts-performance")` before writing any code
  - Seed SQLite with 8,000 job rows; measure workspace+status filter query; assert p99 response time ≤ 75 ms — **Property 8 (workspace+status filter) — Validates: Requirements 3.1, 12.2**
  - Seed with 1,000 chain rows; measure time-range filter query; assert p99 response time ≤ 50 ms — **Property 8 (time-range filter) — Validates: Requirements 3.3, 3.4, 12.2**
  - Seed with 10,000 job rows; measure `GROUP BY status` aggregation; assert p99 response time ≤ 100 ms — **Property 8 (aggregation) — Validates: Requirements 3.5, 12.2**
  - Mock scanners returning 10,000 records; assert `runFullSync` completes within 30 minutes — **Property 10: Bounded Full Sync Duration — Validates: Requirements 6.2, 2.6**
  - Run `runMigrations` against fresh SQLite; assert total wall-clock time ≤ 10 seconds — **Property 9: Bounded Migration Duration — Validates: Requirements 5.6**

- [ ] 32. Final checkpoint — full test suite and type check
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` before proceeding
  - Run `bun test test/` — all tests pass
  - Run `node_modules\.bin\tsc.exe --noEmit` — zero type errors
  - Ensure all tests pass; ask the user if questions arise

## Notes

- Tasks marked `*` are optional and can be skipped for a faster MVP; property tests validate universal correctness and are strongly recommended before merging
- Performance tests in Task 31 are non-optional for the test suite to be considered complete per Requirement 12.2
- Property tests use `fast-check` (`fc.property`, `fc.assert`) per the `accelint-ts-testing` skill
- All queries must use parameterized form — no string interpolation of external input
- SQLite WAL mode is enabled after adapter construction; PostgreSQL skips it entirely
- The `pg` driver is lazy-loaded so the server starts without crashing when only SQLite is configured

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "8"] },
    { "id": 1, "tasks": ["2", "3", "4", "9"] },
    { "id": 2, "tasks": ["5", "6", "10", "11", "12"] },
    { "id": 3, "tasks": ["7", "13", "14", "15", "16"] },
    { "id": 4, "tasks": ["17", "18"] },
    { "id": 5, "tasks": ["19", "25"] },
    { "id": 6, "tasks": ["21", "26"] },
    { "id": 7, "tasks": ["22", "27", "28", "29", "30"] },
    { "id": 8, "tasks": ["20", "23", "24", "31"] },
    { "id": 9, "tasks": ["32"] }
  ]
}
```
