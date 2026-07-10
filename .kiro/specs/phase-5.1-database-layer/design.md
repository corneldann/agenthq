# Design Document

## Overview

Phase 5.1 adds a persistent database layer to AgentHQ, enabling fast indexed queries, historical status tracking, and efficient time-range analytics. This phase introduces SQLite (default) or PostgreSQL support while maintaining files as the source of truth.

The database is a queryable projection that can be rebuilt from files at any time. File-scanning functions (`src/scan/`) remain the canonical data source; the database synchronizes from them via file watchers.

```
Existing:  HTTP Routes ←→ scan/ ←→ file system
Phase 5.1: HTTP Routes ←→ db/   ←→ SQLite / Postgres
                          ↑
           fileWatcher ───┘ (sync from files)
```

### Key Design Principles

1. **Files as source of truth** — Database is always rebuildable from files
2. **Graceful degradation** — Falls back to file scanning if database unavailable
3. **Zero-config SQLite** — Works out of the box, no setup required
4. **Indexed performance** — Sub-100ms queries for common operations
5. **Adapter pattern** — SQLite and PostgreSQL behind unified interface

---

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                   Bun.serve (monitor.ts)                    │
│                                                             │
│  HTTP Routes                        Workers                 │
│  ─────────────                      ───────                 │
│  GET  /jobs                         fileWatcher (Bun.watch) │
│  GET  /chains                       backfill                │
│  GET  /sessions                                             │
│  GET  /api/status-history/:id                               │
└────────────────────────┬────────────────────────────────────┘
                         │
      ┌──────────────────▼──────────────────┐
      │         src/db/  (Database)         │
      │  adapter.ts    — DbAdapter interface│
      │  sqlite-adapter.ts — bun:sqlite     │
      │  postgres-adapter.ts — pg driver    │
      │  schema.ts     — DDL constants      │
      │  migrations.ts — apply migrations/  │
      │  sync.ts       — file → DB sync     │
      └──────────────────┬──────────────────┘
                         │
                    ┌────▼────┐
                    │ SQLite  │
                    │   or    │
                    │Postgres │
                    └─────────┘
```

### Module Structure

```
src/
├── config/
│   └── db-config.ts          # loadDbConfig() — DB env vars
├── db/
│   ├── adapter.ts            # DbAdapter interface + createDbAdapter()
│   ├── schema.ts             # SQL DDL strings + SchemaVersion type
│   ├── migrations.ts         # runMigrations() — discovers migrations/*.sql
│   ├── sqlite-adapter.ts     # SQLiteAdapter implements DbAdapter
│   ├── postgres-adapter.ts   # PostgresAdapter implements DbAdapter
│   └── sync.ts               # DbSyncTool — full scan + incremental upsert
├── routes/
│   └── status-history.ts     # register(router) — /api/status-history/:jobId
└── workers/
    └── fileWatcher.ts        # startFileWatcher() — Bun.watch + debounce
migrations/
├── 001_initial.sql           # workspaces, jobs, chains, sessions
└── 002_status_history.sql    # job_status_history table + indexes
```

---

## Components and Interfaces

### Database Adapter

**`src/db/adapter.ts`** — Defines the `DbAdapter` interface and factory:

```typescript
export interface DbAdapter {
  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  execute(sql: string, params?: unknown[]): Promise<ExecResult>;
  transaction(fn: (adapter: DbAdapter) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface ExecResult {
  rowsAffected: number;
  lastInsertRowid?: number | bigint;
}

export function createDbAdapter(config: DbConfig): DbAdapter {
  if (config.type === 'postgres') {
    return new PostgresAdapter(config.url!);
  }
  const adapter = new SQLiteAdapter(config.path);
  // Enable WAL mode only for SQLite, after initialization completes
  adapter.enableWal();
  return adapter;
}
```

**`src/db/sqlite-adapter.ts`** — SQLite implementation using `bun:sqlite`:

```typescript
import { Database } from 'bun:sqlite';

export class SQLiteAdapter implements DbAdapter {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    // WAL mode enabled after initialization completes (SQLite only — skipped for PostgreSQL)
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  enableWal(): void {
    this.db.exec('PRAGMA journal_mode = WAL');
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as T[];
    return { rows, rowCount: rows.length };
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...params);
    return {
      rowsAffected: result.changes,
      lastInsertRowid: result.lastInsertRowid
    };
  }

  async transaction(fn: (adapter: DbAdapter) => Promise<void>): Promise<void> {
    this.db.exec('BEGIN');
    try {
      await fn(this);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
```

**`src/db/postgres-adapter.ts`** — PostgreSQL implementation using `pg`:

```typescript
import type { Pool, QueryResult as PgQueryResult } from 'pg';

export class PostgresAdapter implements DbAdapter {
  private pool: Pool;

  constructor(connectionString: string) {
    // Lazy-load pg to avoid startup crash when not installed
    const { Pool } = require('pg');
    this.pool = new Pool({ connectionString });
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const result: PgQueryResult<T> = await this.pool.query(sql, params);
    return { rows: result.rows, rowCount: result.rowCount || 0 };
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
    const result = await this.pool.query(sql, params);
    return { rowsAffected: result.rowCount || 0 };
  }

  async transaction(fn: (adapter: DbAdapter) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await fn(this);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
```

### Migration System

**`src/db/migrations.ts`** — Discovers and applies migration files:

```typescript
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { DbAdapter } from './adapter.ts';

export async function runMigrations(
  db: DbAdapter,
  migrationsDir: string
): Promise<void> {
  // Ensure schema_version table exists
  await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL,
      migration_name TEXT NOT NULL
    )
  `);

  // Get current version
  const result = await db.query<{ version: number }>(
    'SELECT MAX(version) as version FROM schema_version'
  );
  const currentVersion = result.rows[0]?.version || 0;

  // Discover migration files
  const files = readdirSync(migrationsDir)
    .filter(f => f.match(/^\d+_.*\.sql$/))
    .sort();

  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10);
    if (version <= currentVersion) continue;

    console.log(`Applying migration ${version}: ${file}`);
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');

    await db.transaction(async (tx) => {
      await tx.execute(sql);
      await tx.execute(
        `INSERT INTO schema_version (version, applied_at, migration_name)
         VALUES (?, datetime('now'), ?)`,
        [version, file]
      );
    });
  }
}
```

### File Watcher

**`src/workers/fileWatcher.ts`** — Watches file system and syncs to database:

```typescript
import { watch } from 'fs';
import type { DbAdapter } from '../db/adapter.ts';
import { DbSyncTool } from '../db/sync.ts';

const debouncers = new Map<string, NodeJS.Timeout>();

export function startFileWatcher(db: DbAdapter, outputDir: string): void {
  const syncTool = new DbSyncTool(db);

  // Initial full scan
  syncTool.runFullSync(outputDir).catch(err => {
    console.error('Initial sync failed:', err);
  });

  // Watch for changes
  watch(outputDir, { recursive: true }, (eventType, filename) => {
    if (!filename) return;

    const path = join(outputDir, filename);

    // Debounce: wait 500ms after last change
    clearTimeout(debouncers.get(path));
    debouncers.set(path, setTimeout(() => {
      syncTool.syncFile(path).catch(err => {
        console.error(`Sync failed for ${path}:`, err);
      });
      debouncers.delete(path);
    }, 500));
  });
}
```

### Database Sync Tool

**`src/db/sync.ts`** — Syncs files to database:

```typescript
import { statSync } from 'fs';
import type { DbAdapter } from './adapter.ts';
import { scanJobs, scanChains, scanSessions } from '../scan/index.ts';

export class DbSyncTool {
  constructor(private db: DbAdapter) {}

  async runFullSync(workspaceId: string): Promise<void> {
    const jobs = await scanJobs(workspaceId);
    const chains = await scanChains(workspaceId);
    const sessions = await scanSessions(workspaceId);

    await this.db.transaction(async (tx) => {
      // Upsert jobs
      for (const job of jobs) {
        await tx.execute(
          `INSERT INTO jobs (id, workspace_id, name, status, timestamp, last_modified, ...)
           VALUES (?, ?, ?, ?, ?, ?, ...)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             last_modified = excluded.last_modified,
             ...`,
          [job.id, workspaceId, job.name, job.status, job.timestamp, Date.now(), ...]
        );
      }

      // Upsert chains
      for (const chain of chains) {
        await tx.execute(
          `INSERT INTO chains (chain_id, workspace_id, display_name, created_at, last_modified, ...)
           VALUES (?, ?, ?, ?, ?, ...)
           ON CONFLICT(chain_id) DO UPDATE SET
             display_name = excluded.display_name,
             last_modified = excluded.last_modified,
             ...`,
          [chain.chain_id, workspaceId, chain.display_name, chain.created_at, Date.now(), ...]
        );
      }

      // Upsert sessions
      for (const session of sessions) {
        await tx.execute(
          `INSERT INTO sessions (chain_id, workspace_id, workflow_hash, status, last_modified, ...)
           VALUES (?, ?, ?, ?, ?, ...)
           ON CONFLICT(chain_id, workflow_hash) DO UPDATE SET
             status = excluded.status,
             last_modified = excluded.last_modified,
             ...`,
          [session.chain_id, workspaceId, session.workflow_hash, session.status, Date.now(), ...]
        );
      }
    });
  }

  async syncFile(filePath: string): Promise<void> {
    // Parse file, determine type (job/chain/session), upsert to database
    // If file deleted, soft-delete in database (set deleted_at)
    const stat = statSync(filePath, { throwIfNoEntry: false });
    if (!stat) {
      // File deleted
      await this.db.execute(
        `UPDATE jobs SET deleted_at = datetime('now')
         WHERE md_file = ? OR log_file = ?`,
        [filePath, filePath]
      );
      return;
    }

    // Parse and upsert (implementation similar to runFullSync)
  }
}
```

---

## Data Models

### Database Row Types

```typescript
// src/db/adapter.ts

export interface DbJob {
  id: string;
  workspace_id: string;
  name: string;
  job_chain: string;
  session_chain_id: string;
  timestamp: string;       // ISO 8601
  type: string;
  agent: string;
  status: 'running' | 'done' | 'reported' | 'error';
  lines: number;
  last_line: string;
  has_log: number;         // SQLite stores booleans as 0/1
  log_error: number;
  md_file: string;
  log_file: string;
  agent_done: string;
  size_bytes: number;
  last_modified: number;   // Unix ms — used for incremental sync
  deleted_at: string | null;
}

export interface DbChain {
  chain_id: string;
  workspace_id: string;
  display_name: string;
  created_at: string;
  last_active_at: string;
  total_messages: number;
  last_modified: number;
  deleted_at: string | null;
}

export interface DbSession {
  chain_id: string;
  workspace_id: string;
  workflow_hash: string;
  chain_index: number;
  status: string;
  message_count: number;
  context_usage_pct: number;
  last_message_at: string;
  last_modified: number;
  deleted_at: string | null;
}

export interface DbJobStatusHistory {
  id: number;            // auto-increment
  job_id: string;
  workspace_id: string;
  old_status: string;
  new_status: string;
  reason: string | null;
  changed_at: string;    // ISO 8601 UTC
}

export interface SchemaVersion {
  version: number;
  applied_at: string;
  migration_name: string;
}
```

---

## Database Schema

```sql
-- migrations/001_initial.sql
-- Creates core tables and indexes. Safe to re-run (IF NOT EXISTS).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version        INTEGER PRIMARY KEY,
  applied_at     TEXT    NOT NULL,
  migration_name TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id             TEXT PRIMARY KEY,
  output_dir     TEXT NOT NULL,
  sessions_dir   TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  job_chain        TEXT NOT NULL DEFAULT '',
  session_chain_id TEXT NOT NULL DEFAULT '',
  timestamp        TEXT NOT NULL,
  type             TEXT NOT NULL DEFAULT '',
  agent            TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL CHECK(status IN ('running','done','reported','error')),
  lines            INTEGER NOT NULL DEFAULT 0,
  last_line        TEXT NOT NULL DEFAULT '',
  has_log          INTEGER NOT NULL DEFAULT 0,
  log_error        INTEGER NOT NULL DEFAULT 0,
  md_file          TEXT NOT NULL DEFAULT '',
  log_file         TEXT NOT NULL DEFAULT '',
  agent_done       TEXT NOT NULL DEFAULT '',
  size_bytes       INTEGER NOT NULL DEFAULT 0,
  last_modified    INTEGER NOT NULL DEFAULT 0,
  deleted_at       TEXT
);

CREATE TABLE IF NOT EXISTS chains (
  chain_id         TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  display_name     TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  last_active_at   TEXT NOT NULL,
  total_messages   INTEGER NOT NULL DEFAULT 0,
  last_modified    INTEGER NOT NULL DEFAULT 0,
  deleted_at       TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  chain_id         TEXT NOT NULL,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_hash    TEXT NOT NULL DEFAULT '',
  chain_index      INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'idle',
  message_count    INTEGER NOT NULL DEFAULT 0,
  context_usage_pct REAL NOT NULL DEFAULT 0,
  last_message_at  TEXT NOT NULL,
  last_modified    INTEGER NOT NULL DEFAULT 0,
  deleted_at       TEXT,
  PRIMARY KEY (chain_id, workflow_hash)
);

-- Indexes for query performance (Requirement 3)
CREATE INDEX IF NOT EXISTS idx_jobs_workspace_status
  ON jobs(workspace_id, status) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_timestamp
  ON jobs(workspace_id, timestamp DESC) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_type_status
  ON jobs(type, status) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_chains_workspace_active
  ON chains(workspace_id, last_active_at DESC) WHERE deleted_at IS NULL;

-- migrations/002_status_history.sql
-- Historical status tracking (Requirement 4)

CREATE TABLE IF NOT EXISTS job_status_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       TEXT    NOT NULL,
  workspace_id TEXT    NOT NULL,
  old_status   TEXT    NOT NULL,
  new_status   TEXT    NOT NULL,
  reason       TEXT,
  changed_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_status_history_job
  ON job_status_history(job_id, changed_at DESC);
```

---

## Configuration

### Environment Variables

```typescript
// src/config/db-config.ts

export interface DbConfig {
  enabled: boolean;      // DB_ENABLED (default: true)
  type: 'sqlite' | 'postgres';  // DB_TYPE (default: sqlite)
  path: string;          // DB_PATH (default: .agenthq.db)
  url?: string;          // DB_URL (required when type=postgres)
}

export function loadDbConfig(env: Record<string, string | undefined>): DbConfig {
  const enabled = env.DB_ENABLED?.toLowerCase();
  if (enabled && enabled !== 'true' && enabled !== 'false') {
    throw new Error(`DB_ENABLED must be 'true' or 'false', got '${enabled}'`);
  }

  const type = (env.DB_TYPE || 'sqlite') as 'sqlite' | 'postgres';
  if (type !== 'sqlite' && type !== 'postgres') {
    throw new Error(`DB_TYPE must be 'sqlite' or 'postgres', got '${type}'`);
  }

  if (type === 'postgres' && !env.DB_URL) {
    throw new Error('DB_URL is required when DB_TYPE=postgres');
  }

  return {
    enabled: enabled !== 'false',
    type,
    path: env.DB_PATH || '.agenthq.db',
    url: env.DB_URL
  };
}
```

---

## Query Patterns

### Common Queries

**Get jobs by workspace and status:**
```sql
SELECT * FROM jobs
WHERE workspace_id = ? AND status = ? AND deleted_at IS NULL
ORDER BY timestamp DESC
LIMIT 100;
```

**Get recent jobs (time range filter):**
```sql
SELECT * FROM jobs
WHERE workspace_id = ?
  AND timestamp >= datetime('now', '-7 days')
  AND deleted_at IS NULL
ORDER BY timestamp DESC;
```

**Get job status history:**
```sql
SELECT old_status, new_status, reason, changed_at
FROM job_status_history
WHERE job_id = ?
ORDER BY changed_at DESC;
```

**Aggregate job counts by status:**
```sql
SELECT status, COUNT(*) as count
FROM jobs
WHERE workspace_id = ? AND deleted_at IS NULL
GROUP BY status;
```

---

## Error Handling Strategy

1. **Database unavailable** → Fall back to file scanning, log warning
2. **Parse error** → Skip file, log error, continue watching
3. **Migration failure** → Rollback, refuse to start, preserve schema version
4. **Disk space low (≥90%)** → Log critical warning, continue operation
5. **Upsert failure** → Schedule retry on next file change

---

## Testing Strategy

### Unit Tests
- Database adapter operations (insert, update, query, delete)
- Migration discovery and application
- Config parsing and validation

### Integration Tests
- File watcher → database sync flow
- Graceful fallback to file scanning
- Status history tracking

### Performance Tests
- Query response times within bounds: workspace+status filter ≤75ms (fewer than 8,000 jobs), time-range filter ≤50ms (fewer than 1,000 chains), aggregation ≤100ms (fewer than 10,000 jobs)
- Concurrent access (if PostgreSQL)

---

## Correctness Properties

### Property 1: Database-File Consistency
*For any* job J in the database with `deleted_at = NULL`, a corresponding source file MUST exist in the workspace output directory. After a `syncFile(path)` call where the file is confirmed absent, the record's `deleted_at` SHALL be set.

**Validates: Requirements 6.4, 2.4**

### Property 2: Monotonic Status History Timestamps
*For any* job_id in `job_status_history`, all rows ordered by `changed_at` DESC MUST reflect a non-decreasing sequence of wall-clock times — no status-change record MAY have a `changed_at` earlier than any previously inserted record for the same job.

**Validates: Requirements 4.1, 4.4**

### Property 3: Foreign Key Integrity
*For any* insert or upsert into jobs, chains, or sessions, the operation MUST reference a workspace_id that already exists in the workspaces table; the database MUST reject any insert that violates this constraint via `FOREIGN KEY ON DELETE CASCADE`.

**Validates: Requirements 1.5**

### Property 4: Schema Version Coherence
*For any* database opened by the migration system, the `MAX(version)` in schema_version MUST never exceed the code's expected migration count; schema_version MUST increase monotonically and MUST only be written within the same transaction as the corresponding migration SQL.

**Validates: Requirements 5.3, 5.5**

### Property 5: Request Gate During Initialization
*For any* HTTP request received while DB_ENABLED=true and database initialization is still in progress, the server MUST NOT return a response sourced from the database until initialization completes; only file-scan fallback responses are permitted while initialization is pending.

**Validates: Requirements 8.4**

### Property 6: File Sync Idempotence
*For any* file path P with unchanged content, calling `syncFile(P)` a second time MUST produce zero changes to the database — row counts, timestamps, and all field values MUST be identical to those after the first call.

**Validates: Requirements 6.3**

### Property 7: Query Result Stability
*For any* two identical SQL queries with identical parameters executed with no intervening writes, the result sets MUST be identical (modulo auto-generated timestamp fields).

**Validates: Requirements 3.1, 3.3, 3.5**

### Property 8: Bounded Query Response Time
*For any* indexed query against a dataset within specified size limits, response times MUST satisfy: workspace+status filter ≤75ms for fewer than 8,000 jobs; time-range filter ≤50ms for fewer than 1,000 chains; aggregation ≤100ms for fewer than 10,000 jobs.

**Validates: Requirements 3.1, 3.3, 3.4, 3.5, 12.2**

### Property 9: Bounded Migration Duration
*For any* set of pending migrations applied at startup, total migration wall-clock time MUST NOT exceed 10 seconds; if exceeded, the server MUST refuse to start.

**Validates: Requirements 5.6**

### Property 10: Bounded Full Sync Duration
*For any* workspace containing up to 10,000 files, the initial full sync on first run MUST complete within 30 minutes.

**Validates: Requirements 6.2, 2.6**

---

## Error Handling

### Failure Modes and Recovery

**Database Connection Failure**
- **Detection:** Connection attempt throws exception or times out
- **Response:** Log error "database connection failed: <reason>", fall back to file scanning
- **Recovery:** Retry connection on next monitor restart; file scanning continues uninterrupted

**File Parse Error**
- **Detection:** JSON.parse fails or required fields missing
- **Response:** Log error "parse failed: <path>: <reason>", skip file, continue monitoring
- **Recovery:** File watcher will retry on next file modification; corrupted files can be manually fixed

**Migration Failure**
- **Detection:** SQL execution error during migration transaction
- **Response:** Attempt rollback; log error "migration <N> failed: <reason>"; refuse to start server regardless of whether rollback succeeds
- **Recovery:** If rollback succeeds, previous schema version is preserved — fix migration SQL and restart. If rollback itself fails, log "migration <N> rollback failed: <reason>", accept inconsistent state, and require manual schema inspection before restarting

**File Deleted During Parse**
- **Detection:** File is removed while the watcher has already started reading it
- **Response:** Allow parsing to complete on the in-memory content already read; proceed with normal upsert logic using that content
- **Recovery:** Subsequent watcher events will soft-delete the record once the file absence is confirmed

**Disk Space Exhaustion**
- **Detection:** Database size / available space ≥ 0.9
- **Response:** Log critical warning "Database approaching disk limit: <percent>% used", continue operation
- **Recovery:** User must free disk space or relocate database; no automatic recovery

**Upsert Failure**
- **Detection:** Database execute() throws exception during file sync
- **Response:** Log error "upsert failed: <path>: <db_error>", schedule retry on next file change
- **Recovery:** Automatic retry on next file modification; persistent failures require investigation

---

## Migration Path

1. **Fresh install** — Database populates automatically from files on first run
2. **Upgrade from v1.x** — File watcher performs initial full scan, no user action required
3. **Database corruption** — Delete `.agenthq.db`, restart monitor, full rescan from files
4. **Switch SQLite ↔ PostgreSQL** — Change `DB_TYPE` + `DB_URL`, restart, automatic rescan
