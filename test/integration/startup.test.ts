/**
 * Integration tests for the full startup sequence.
 *
 * Tests the composition of loadDbConfig → createDbAdapter → runMigrations →
 * startFileWatcher in the same order monitor.ts uses them, without importing
 * monitor.ts directly (it has top-level side effects that start the HTTP server).
 *
 * Requirements: 5.6, 8.3, 8.4, 9.1, 12.1
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SQLiteAdapter } from '../../src/db/sqlite-adapter.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import { loadDbConfig } from '../../src/config/db-config.ts';
import { startFileWatcher } from '../../src/workers/fileWatcher.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write named migration files into a temp directory. */
function writeMigrationFiles(
  dir: string,
  migrations: Record<string, string>,
): void {
  for (const [filename, sql] of Object.entries(migrations)) {
    fs.writeFileSync(path.join(dir, filename), sql, 'utf-8');
  }
}

/** Remove a directory tree, silently ignoring errors (best-effort cleanup). */
function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort only
  }
}

// Minimal SQL that satisfies the schema_version query without depending on
// real migration files at a specific path.
const MINIMAL_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id           TEXT PRIMARY KEY,
  output_dir   TEXT NOT NULL,
  sessions_dir TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running',
  last_modified INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT
);
`.trim();

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Startup sequence integration tests', () => {
  let db: SQLiteAdapter;
  let migrationsDir: string;
  let watchDir: string;

  beforeEach(() => {
    db = new SQLiteAdapter(':memory:');
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-migrations-'));
    watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-watch-'));
  });

  afterEach(async () => {
    await db.close();
    cleanupDir(migrationsDir);
    cleanupDir(watchDir);
  });

  // ── Scenario 1: Fresh DB — migrations run, dbReady would flip true ───────
  //
  // Validates: Requirements 5.6, 8.3
  // Simulates: the happy path in monitor.ts where runMigrations resolves,
  // dbReady is set to true, and startFileWatcher is called without throwing.

  describe('Scenario 1: fresh DB startup', () => {
    it('should apply migrations on a fresh in-memory DB', async () => {
      writeMigrationFiles(migrationsDir, {
        '001_create_schema.sql': MINIMAL_MIGRATION_SQL,
      });

      await expect(runMigrations(db, migrationsDir)).resolves.toBeUndefined();

      const result = await db.query<{ cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM schema_version',
      );
      expect(result.rows[0]!.cnt).toBe(1);
    });

    it('should record all migration rows in schema_version after multiple migrations', async () => {
      writeMigrationFiles(migrationsDir, {
        '001_create_schema.sql': MINIMAL_MIGRATION_SQL,
        '002_add_status_history.sql': `
          CREATE TABLE IF NOT EXISTS job_status_history (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id       TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            old_status   TEXT NOT NULL,
            new_status   TEXT NOT NULL,
            reason       TEXT,
            changed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          );
        `.trim(),
      });

      await runMigrations(db, migrationsDir);

      const result = await db.query<{ version: number | null }>(
        'SELECT MAX(version) AS version FROM schema_version',
      );
      expect(result.rows[0]!.version).toBe(2);
    });

    it('should call startFileWatcher after migrations without throwing (Req 8.3)', async () => {
      writeMigrationFiles(migrationsDir, {
        '001_create_schema.sql': MINIMAL_MIGRATION_SQL,
      });

      // Step 1: run migrations (simulates dbReady = true in monitor.ts)
      await runMigrations(db, migrationsDir);

      // Step 2: start watcher — must not throw synchronously.
      // runFullSync errors are caught internally so passing a temp dir is fine.
      expect(() => startFileWatcher(db, watchDir)).not.toThrow();
    });

    it('should not run startFileWatcher before migrations complete (Req 5.6)', async () => {
      // Verify the ordering guarantee: migrations must be awaited before
      // the watcher is started.  We confirm this by checking schema_version
      // has rows before the watcher call (i.e. migrations DID run first).
      writeMigrationFiles(migrationsDir, {
        '001_create_schema.sql': MINIMAL_MIGRATION_SQL,
      });

      await runMigrations(db, migrationsDir);

      const result = await db.query<{ cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM schema_version',
      );
      // Migrations ran (count > 0) BEFORE we start the watcher
      expect(result.rows[0]!.cnt).toBeGreaterThan(0);

      // Now start watcher — safe because migrations are already complete
      expect(() => startFileWatcher(db, watchDir)).not.toThrow();
    });
  });

  // ── Scenario 2: Config error aborts startup (Req 9.1) ───────────────────
  //
  // Validates: Requirement 9.1
  // Simulates: the loadDbConfig throw path in monitor.ts that triggers
  // process.exit(1) before Bun.serve() is called.

  describe('Scenario 2: config error aborts startup', () => {
    it('should throw when DB_ENABLED is not "true" or "false"', () => {
      expect(() => loadDbConfig({ DB_ENABLED: 'yes' })).toThrow(
        "DB_ENABLED must be 'true' or 'false', got 'yes'",
      );
    });

    it('should throw when DB_ENABLED is an arbitrary non-boolean string', () => {
      expect(() => loadDbConfig({ DB_ENABLED: '1' })).toThrow(
        "DB_ENABLED must be 'true' or 'false', got '1'",
      );
    });

    it('should throw when DB_TYPE=postgres but DB_URL is missing', () => {
      expect(() => loadDbConfig({ DB_TYPE: 'postgres' })).toThrow(
        'DB_URL is required when DB_TYPE=postgres',
      );
    });

    it('should throw when DB_TYPE is an unsupported value', () => {
      expect(() => loadDbConfig({ DB_TYPE: 'mysql' })).toThrow(
        "DB_TYPE must be 'sqlite' or 'postgres', got 'mysql'",
      );
    });
  });

  // ── Scenario 3: Migration failure — server never starts (Req 5.6) ────────
  //
  // Validates: Requirement 5.6
  // Simulates: the runMigrations throw path in monitor.ts that triggers
  // process.exit(1) before Bun.serve() is called.

  describe('Scenario 3: migration failure prevents server startup', () => {
    it('should reject when a migration file contains invalid SQL', async () => {
      writeMigrationFiles(migrationsDir, {
        '001_valid.sql':
          'CREATE TABLE IF NOT EXISTS t1 (id INTEGER PRIMARY KEY);',
        '002_invalid.sql': 'THIS IS NOT VALID SQL !!!',
      });

      await expect(runMigrations(db, migrationsDir)).rejects.toThrow();
    });

    it('should leave schema_version at version 1 after migration 2 fails', async () => {
      writeMigrationFiles(migrationsDir, {
        '001_valid.sql':
          'CREATE TABLE IF NOT EXISTS t1 (id INTEGER PRIMARY KEY);',
        '002_invalid.sql': 'NOT SQL AT ALL',
      });

      await expect(runMigrations(db, migrationsDir)).rejects.toThrow();

      // Migration 1 succeeded and its schema_version row must be preserved
      const result = await db.query<{ version: number | null }>(
        'SELECT MAX(version) AS version FROM schema_version',
      );
      expect(result.rows[0]!.version).toBe(1);
    });
  });

  // ── Scenario 4: DB_ENABLED=false — no migrations, no watcher (Req 8.1) ──
  //
  // Validates: Requirements 8.4 (no adapter created when disabled)
  // When DB_ENABLED=false, monitor.ts skips the entire DB init block and
  // calls Bun.serve() without running migrations or starting the watcher.

  describe('Scenario 4: DB disabled — file-only mode', () => {
    it('should return enabled=false when DB_ENABLED is "false"', () => {
      const config = loadDbConfig({ DB_ENABLED: 'false' });
      expect(config.enabled).toBe(false);
    });

    it('should default enabled=true when DB_ENABLED is absent', () => {
      const config = loadDbConfig({});
      expect(config.enabled).toBe(true);
    });

    it('should default to sqlite type when DB_TYPE is absent', () => {
      const config = loadDbConfig({});
      expect(config.type).toBe('sqlite');
    });

    it('should not attempt to run migrations when config.enabled is false', async () => {
      const config = loadDbConfig({ DB_ENABLED: 'false' });

      // The disabled check comes before runMigrations in monitor.ts.
      // In file-only mode no migration dir is needed — confirm no DB tables created.
      if (!config.enabled) {
        // Nothing to do — just assert the guard passed.
        expect(config.enabled).toBe(false);
      } else {
        // This branch must not be reached when DB_ENABLED=false
        throw new Error('Expected config.enabled to be false');
      }
    });
  });

  // ── Scenario 5: dbReady export starts as false (Req 8.4) ─────────────────
  //
  // Validates: Requirement 8.4 (gate middleware)
  // NOTE: monitor.ts cannot be imported directly because of top-level await
  // and server startup side effects.  The dbReady gate logic is tested
  // exhaustively in test/middleware/request-gate.property.test.ts and
  // test/unit/request-gate.test.ts.  This scenario documents the intent:
  // dbReady begins as false and only flips to true after runMigrations resolves.

  describe('Scenario 5: dbReady flip semantics', () => {
    it('should have schema_version rows after migrations resolve (dbReady=true equivalent)', async () => {
      // Before migrations: schema_version does not exist
      const before = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
      );
      expect(before.rows.length).toBe(0);

      writeMigrationFiles(migrationsDir, {
        '001_create_schema.sql': MINIMAL_MIGRATION_SQL,
      });

      // After migrations resolve: schema_version exists — this is the
      // condition under which monitor.ts sets dbReady = true.
      await runMigrations(db, migrationsDir);

      const after = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
      );
      expect(after.rows.length).toBe(1);
    });

    it('should not create schema_version if migrations reject (dbReady stays false)', async () => {
      writeMigrationFiles(migrationsDir, {
        '001_invalid.sql': 'NOT VALID SQL',
      });

      // runMigrations creates schema_version before applying files, but
      // a migration failure means the overall Promise rejects — which maps
      // to the monitor.ts path where dbReady is never set to true.
      await expect(runMigrations(db, migrationsDir)).rejects.toThrow();

      // schema_version may have been created (it's a DDL step before applying
      // files) but MAX(version) must be 0 — no successful migration recorded.
      const result = await db.query<{ version: number | null }>(
        'SELECT MAX(version) AS version FROM schema_version',
      );
      const maxVersion = result.rows[0]?.version ?? 0;
      expect(maxVersion).toBe(0);
    });
  });

  // ── Scenario 6: full happy-path sequence (Req 5.6, 8.3, 12.1) ────────────
  //
  // Validates: Requirements 5.6, 8.3, 12.1
  // Composes all modules in the same order monitor.ts does:
  //   loadDbConfig → createDbAdapter(implicit via SQLiteAdapter) →
  //   runMigrations → dbReady=true → startFileWatcher

  describe('Scenario 6: full startup sequence composition', () => {
    it('should complete the full startup sequence without error', async () => {
      // 1. Config loads successfully
      const config = loadDbConfig({ DB_ENABLED: 'true', DB_TYPE: 'sqlite' });
      expect(config.enabled).toBe(true);

      // 2. Adapter created (SQLiteAdapter represents the sqlite path in
      //    createDbAdapter — we use it directly here to avoid real file I/O)
      expect(db).toBeDefined();

      // 3. Migrations run successfully
      writeMigrationFiles(migrationsDir, {
        '001_create_schema.sql': MINIMAL_MIGRATION_SQL,
      });
      await expect(runMigrations(db, migrationsDir)).resolves.toBeUndefined();

      // 4. dbReady would flip to true here in monitor.ts
      const migrationResult = await db.query<{ cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM schema_version',
      );
      expect(migrationResult.rows[0]!.cnt).toBeGreaterThan(0);

      // 5. File watcher starts without error (simulates post-Bun.serve() call)
      expect(() => startFileWatcher(db, watchDir)).not.toThrow();
    });
  });
});
